param(
  [ValidateSet('local','server')][string]$Edition = 'local',
  [string]$Action = 'default',
  [switch]$Library,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$script:Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:Work = Join-Path $script:Root 'work/deployment'
$script:SettingsPath = Join-Path $script:Work 'settings.json'
$script:Node = $null
$script:SshArgs = @()
function Write-Stage([string]$Message,[string]$ConsoleMessage='') {
  if(-not $ConsoleMessage){$ConsoleMessage=$Message}
  Write-Host ('[Music Bot] ' + $ConsoleMessage)
  [IO.Directory]::CreateDirectory($script:Work) | Out-Null
  [IO.File]::AppendAllText((Join-Path $script:Work ($Edition+'-last.log')),([DateTime]::Now.ToString('s')+' '+$Message+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
}
function New-NativeProcess([string]$File,[string[]]$Arguments,[bool]$Capture) {
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$File
  $info.Arguments=($Arguments | ForEach-Object { Quote-Native $_ }) -join ' '
  $info.WorkingDirectory=$script:Root
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  if ($Capture) { $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=[Text.Encoding]::UTF8;$info.StandardErrorEncoding=[Text.Encoding]::UTF8 }
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  $null=$process.Start()
  return $process
}
function Get-Native([string]$File,[string[]]$Arguments) {
  $process=New-NativeProcess $File $Arguments $true
  try {
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit();$output=$stdout.Result;$failure=$stderr.Result
    if ($process.ExitCode -ne 0) { if ($failure) { Write-Host $failure };throw ('命令执行失败：'+[IO.Path]::GetFileName($File)+'，退出码 '+$process.ExitCode) }
    return ($output.TrimEnd([char]13,[char]10) -split '\r?\n')
  } finally { $process.Dispose() }
}
function Invoke-Native([string]$File,[string[]]$Arguments,[switch]$ShowOutput,[string]$Activity='Running setup task') {
  $process=New-NativeProcess $File $Arguments ([bool]$ShowOutput)
  try {
    if($ShowOutput) {
      $outTask=$process.StandardOutput.ReadLineAsync();$errTask=$process.StandardError.ReadLineAsync()
      $clock=[Diagnostics.Stopwatch]::StartNew();$lastOutput=0.0
      while($outTask -or $errTask -or -not $process.HasExited) {
        while($outTask -and $outTask.IsCompleted) {
          $line=$outTask.GetAwaiter().GetResult()
          if($null -eq $line){$outTask=$null;break}
          if($line -match '^\[Setup\] (.+)$'){$Activity=$Matches[1]};Write-Host $line;$lastOutput=$clock.Elapsed.TotalSeconds;$outTask=$process.StandardOutput.ReadLineAsync()
        }
        while($errTask -and $errTask.IsCompleted) {
          $line=$errTask.GetAwaiter().GetResult()
          if($null -eq $line){$errTask=$null;break}
          if($line -match '^\[Setup\] (.+)$'){$Activity=$Matches[1]};Write-Host $line;$lastOutput=$clock.Elapsed.TotalSeconds;$errTask=$process.StandardError.ReadLineAsync()
        }
        if($clock.Elapsed.TotalSeconds-$lastOutput -ge 10) {
          Write-Host ('[Status] '+$Activity+' | '+[Math]::Floor($clock.Elapsed.TotalSeconds)+'s elapsed | waiting for new output; download progress unknown')
          $lastOutput=$clock.Elapsed.TotalSeconds
        }
        if($outTask -or $errTask -or -not $process.HasExited){Start-Sleep -Milliseconds 50}
      }
    }
    $process.WaitForExit()
    if($process.ExitCode -ne 0){throw ('Command failed: '+[IO.Path]::GetFileName($File)+'; exit code '+$process.ExitCode)}
  } finally { $process.Dispose() }
}
function Write-DownloadStatus([string]$Label,[long]$Bytes,[long]$Total,$Clock,$Progress,[switch]$Complete) {
  $elapsed=$Clock.Elapsed.TotalSeconds
  $period=[Math]::Max(0.001,$elapsed-$Progress.LastAt)
  $speed=[Math]::Max(0,($Bytes-$Progress.LastBytes)/$period/1024)
  $size=('{0:F2} MiB' -f ($Bytes/1MB))
  if($Total -gt 0){$size=('{0:F2} / {1:F2} MiB ({2:F0}%)' -f ($Bytes/1MB),($Total/1MB),[Math]::Min(100,[Math]::Floor($Bytes*100.0/$Total)))}
  $suffix='';if($Complete){$suffix=' | complete'}
  Write-Host ('[Download] {0}: {1} | {2:F1} KiB/s | {3:F0}s elapsed{4}' -f $Label,$size,$speed,$elapsed,$suffix)
  $Progress.LastAt=$elapsed;$Progress.LastBytes=$Bytes
}
function Receive-File([uri]$Uri,[string]$Destination,[string]$Label,[int]$ConnectTimeoutSeconds=30,[int]$IdleTimeoutSeconds=30,[int]$TimeoutSeconds=600) {
  if($Uri.Scheme -ne 'https' -and -not($Uri.Scheme -eq 'http' -and $Uri.IsLoopback)){throw 'Download requires HTTPS'}
  if(-not $Destination.EndsWith('.part',[StringComparison]::OrdinalIgnoreCase)){throw 'Download destination must be a temporary .part file'}
  if($ConnectTimeoutSeconds -lt 1 -or $IdleTimeoutSeconds -lt 1 -or $TimeoutSeconds -lt 1){throw 'Download timeout must be positive'}
  Add-Type -AssemblyName System.Net.Http
  $destinationPath=[IO.Path]::GetFullPath($Destination)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destinationPath))|Out-Null
  $client=[Net.Http.HttpClient]::new();$client.Timeout=[Threading.Timeout]::InfiniteTimeSpan
  $connect=[Threading.CancellationTokenSource]::new();$connect.CancelAfter([TimeSpan]::FromSeconds([Math]::Min($ConnectTimeoutSeconds,$TimeoutSeconds)))
  $response=$null;$inputStream=$null;$outputStream=$null;$created=$false;$success=$false
  $clock=[Diagnostics.Stopwatch]::StartNew();$progress=@{LastAt=0.0;LastBytes=0L}
  Write-Host ('[Download] Connecting to {0}; connection timeout {1}s...' -f $Uri.Host,[Math]::Min($ConnectTimeoutSeconds,$TimeoutSeconds))
  try {
    try{$response=$client.GetAsync($Uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$connect.Token).GetAwaiter().GetResult()}
    catch{throw ('Download connection failed or timed out: '+$_.Exception.GetBaseException().Message)}
    if(-not $response.IsSuccessStatusCode){throw ('Download failed: HTTP '+[int]$response.StatusCode)}
    $total=0L;if($null -ne $response.Content.Headers.ContentLength){$total=[long]$response.Content.Headers.ContentLength}
    $inputStream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $outputStream=[IO.File]::Open($destinationPath,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read);$created=$true
    $buffer=New-Object byte[] 65536;$received=0L;$lastData=$clock.Elapsed.TotalSeconds
    Write-DownloadStatus $Label $received $total $clock $progress
    while($true) {
      $read=$inputStream.ReadAsync($buffer,0,$buffer.Length)
      while(-not $read.IsCompleted) {
        if($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds){throw ('Download exceeded '+$TimeoutSeconds+' seconds. Run the same launcher to retry.')}
        if($clock.Elapsed.TotalSeconds-$lastData -ge $IdleTimeoutSeconds){throw ('No download data for '+$IdleTimeoutSeconds+' seconds. Check the network and run the same launcher to retry.')}
        if($clock.Elapsed.TotalSeconds-$progress.LastAt -ge 1){Write-DownloadStatus $Label $received $total $clock $progress}
        Start-Sleep -Milliseconds 100
      }
      $count=$read.GetAwaiter().GetResult()
      if($count -eq 0){break}
      if($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds){throw ('Download exceeded '+$TimeoutSeconds+' seconds. Run the same launcher to retry.')}
      $outputStream.Write($buffer,0,$count);$received+=$count;$lastData=$clock.Elapsed.TotalSeconds
      if($clock.Elapsed.TotalSeconds-$progress.LastAt -ge 1){Write-DownloadStatus $Label $received $total $clock $progress}
    }
    if($total -gt 0 -and $received -ne $total){throw 'Download ended before the expected file size was received'}
    $outputStream.Flush();$outputStream.Dispose();$outputStream=$null;$success=$true
    Write-DownloadStatus $Label $received $total $clock $progress -Complete
  } finally {
    if($outputStream){$outputStream.Dispose()}
    if($inputStream){$inputStream.Dispose()}
    if($response){$response.Dispose()}
    $connect.Dispose();$client.Dispose()
    if($created -and -not $success -and (Test-Path -LiteralPath $destinationPath)){Remove-Item -LiteralPath $destinationPath -Force}
  }
}
function Ensure-Node {
  if ($script:Node) { return }
  $candidates=@((Join-Path $script:Root 'resources/node/node.exe'),(Join-Path $script:Root 'work/toolchain/node-v22.14.0-win-x64/node.exe'))
  $installed=Get-Command node.exe -ErrorAction SilentlyContinue
  if ($installed) { $candidates+= $installed.Source }
  foreach ($candidate in $candidates) {
    $cli=Join-Path (Split-Path $candidate) 'node_modules/npm/bin/npm-cli.js'
    if ((Test-Path -LiteralPath $candidate) -and (Test-Path -LiteralPath $cli)) {
      $version=@(Get-Native $candidate @('--version')) -join ''
      if ($version -match '^v22[.]') { $script:Node=$candidate; $env:TSMD_NPM_CLI=$cli; break }
    }
  }
  if (-not $script:Node) {
    Write-Stage '首次准备官方 Node.js 22 工具链…' -ConsoleMessage 'Preparing the official Node.js 22 toolchain...'
    $cache=Join-Path $script:Root 'work/toolchain'
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $zip=Join-Path $cache 'node-v22.14.0-win-x64.zip'
    $expected='55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217'
    if (-not (Test-Path -LiteralPath $zip)) {
      [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
      Receive-File -Uri 'https://nodejs.org/download/release/v22.14.0/node-v22.14.0-win-x64.zip' -Destination ($zip+'.part') -Label 'Node.js 22'
      if ((Get-FileHash -LiteralPath ($zip+'.part') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node.js 下载校验失败，未使用该文件。' }
      Move-Item -LiteralPath ($zip+'.part') -Destination $zip
    }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node.js 缓存校验失败。' }
    Write-Stage 'Node.js 下载校验通过，正在解压…' -ConsoleMessage 'Node.js checksum verified. Extracting the toolchain...'
    Expand-Archive -LiteralPath $zip -DestinationPath $cache -Force
    $script:Node=Join-Path $cache 'node-v22.14.0-win-x64/node.exe'
    $env:TSMD_NPM_CLI=Join-Path (Split-Path $script:Node) 'node_modules/npm/bin/npm-cli.js'
  }
  $env:Path=(Split-Path $script:Node)+';'+$env:Path
}
function Prepare-Project([string]$Mode,[switch]$Package) {
  if ($Mode -ne 'server') { throw '本地版请从 Releases 下载完整 ZIP；源码打包请自行准备依赖后使用 npm run package:win。' }
  Ensure-Node
  $verb='prepare'; if ($Package) { $verb='package' }
  Invoke-Native $script:Node @('scripts/prepare-project.mjs',$verb,$Mode) -ShowOutput -Activity ('Preparing '+$Mode+' edition')
}
function Read-Settings([switch]$Reset) {
  if ((Test-Path -LiteralPath $script:SettingsPath) -and -not $Reset) { $settings=Get-Content -LiteralPath $script:SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  else {
    Write-Host '首次填写一次服务器信息；以后部署、更新和控制台都复用。'
    $target=Read-Host 'SSH 地址，例如 ubuntu@203.0.113.10'
    $port=Read-Host 'SSH 端口（回车使用 22）'; if (-not $port) { $port=22 }
    $fingerprint=Read-Host '已核实的 ED25519 主机指纹（SHA256: 开头）'
    $keys=@('id_ed25519','id_rsa') | ForEach-Object { Join-Path $env:USERPROFILE ('.ssh/'+$_) } | Where-Object { Test-Path -LiteralPath $_ }
    if (-not $keys) { $keys=@((Read-Host 'SSH 私钥文件完整路径（只填写路径）')) }
    $settings=[pscustomobject]@{target=$target;port=[int]$port;fingerprint=$fingerprint;keyFiles=@($keys);consolePort=18080}
  }
  Assert-Settings $settings
  $script:Config=$settings
  if ($Reset -or -not (Test-Path -LiteralPath $script:SettingsPath)) {
    [IO.Directory]::CreateDirectory($script:Work) | Out-Null
    [IO.File]::WriteAllText($script:SettingsPath,($settings | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
  }
  return $settings
}
function Assert-Settings($Settings) {
  if ($Settings.target -notmatch '^[A-Za-z_][A-Za-z0-9_.-]*@([A-Za-z0-9][A-Za-z0-9.-]{0,252})$') { throw 'SSH 地址格式无效，请使用 用户名@IPv4或域名。' }
  if ([int]$Settings.port -lt 1 -or [int]$Settings.port -gt 65535) { throw 'SSH 端口无效。' }
  if ($Settings.fingerprint -notmatch '^SHA256:[A-Za-z0-9+/]{43}=?$') { throw '请填写完整 ED25519 SHA256 主机指纹。' }
  if ([int]$Settings.consolePort -lt 1024 -or [int]$Settings.consolePort -gt 65535) { throw '本机管理端口无效。' }
  if (-not $Settings.keyFiles -or @($Settings.keyFiles).Count -gt 4) { throw 'SSH 私钥路径无效。' }
  foreach ($key in $Settings.keyFiles) { if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw ('未找到 SSH 私钥文件：'+$key) } }
}
function Connect-Settings {
  $null=Read-Settings
  $script:Ssh=Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
  $script:Scp=Join-Path $env:WINDIR 'System32/OpenSSH/scp.exe'
  $keygen=Join-Path $env:WINDIR 'System32/OpenSSH/ssh-keygen.exe'
  foreach ($exe in @($script:Ssh,$script:Scp,$keygen)) { if (-not (Test-Path -LiteralPath $exe)) { throw 'Windows OpenSSH 客户端未安装。' } }
  $known=Join-Path $env:USERPROFILE '.ssh/known_hosts'
  if (-not (Test-Path -LiteralPath $known)) { throw '请先在自己的终端 SSH 登录一次，核实服务器主机指纹后重试。' }
  $hostName=$script:Config.target.Split('@')[1]
  $lookup=$hostName; if ([int]$script:Config.port -ne 22) { $lookup='['+$hostName+']:'+$script:Config.port }
  $records=@(Get-Native $keygen @('-F',$lookup,'-f',$known)) | Where-Object { $_ -and -not $_.StartsWith('#') }
  $pinned=@(); $candidate=Join-Path $script:Work 'candidate-host'
  foreach ($record in $records) {
    [IO.File]::WriteAllText($candidate,$record+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    $details=@(Get-Native $keygen @('-E','sha256','-lf',$candidate)) -join ' '
    if ($details.Contains($script:Config.fingerprint) -and $details.Contains('(ED25519)')) { $pinned+=$record }
  }
  if (-not $pinned.Count) { throw '主机指纹不匹配，已停止；没有连接或修改服务器。' }
  $pinFile=Join-Path $script:Work 'known_hosts'
  [IO.File]::WriteAllLines($pinFile,[string[]]$pinned,[Text.UTF8Encoding]::new($false))
  $script:SshArgs=@('-o','BatchMode=yes','-o','HostKeyAlgorithms=ssh-ed25519','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=work/deployment/known_hosts','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4','-o','IdentitiesOnly=yes')
  foreach ($key in $script:Config.keyFiles) { $script:SshArgs+=@('-i',[string]$key) }
}
function Remote([string]$Command,[switch]$Capture,[switch]$Interactive) {
  $nativeArguments=@($script:SshArgs)+@('-p',[string]$script:Config.port)
  if ($Interactive) { $nativeArguments=@('-t')+$nativeArguments }
  $nativeArguments+=@([string]$script:Config.target,$Command)
  if ($Capture) { return @(Get-Native $script:Ssh $nativeArguments) }
  Invoke-Native $script:Ssh $nativeArguments
}
function Upload([string]$Source,[string]$RemoteName) {
  if ($RemoteName -notmatch '^tsmd-[A-Za-z0-9.-]+$') { throw '远程上传路径无效。' }
  $file=Join-Path $script:Root $Source
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('缺少部署文件：'+$Source) }
  Invoke-Native $script:Scp (@($script:SshArgs)+@('-P',[string]$script:Config.port,$file,([string]$script:Config.target+':'+$RemoteName)))
}
function Probe-Server {
  $command='set -eu; load=$(systemctl show ts-music-desk.service -p LoadState --value); if [ "$load" = not-found ]; then printf "TSMD_INSTALLED=0\n"; exit; fi; app=$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)"); case "$app/" in "$HOME/"?*/) ;; *) echo "Unexpected application directory" >&2; exit 22;; esac; test -x "$app/runtime/node/bin/node"; test -f "$app/server-data/server-admin.json"; printf "TSMD_INSTALLED=1\n"; if [ -x "$app/runtime/official-browser/chrome-linux64/chrome" ]; then printf "TSMD_BROWSER=1\n"; else printf "TSMD_BROWSER=0\n"; fi'
  $lines=@(Remote $command -Capture)
  if ($lines -contains 'TSMD_INSTALLED=0') { return @{installed=$false;browser=$false} }
  if ($lines -contains 'TSMD_INSTALLED=1') { return @{installed=$true;browser=($lines -contains 'TSMD_BROWSER=1')} }
  throw '未能识别服务器安装状态，已停止。'
}
function Version { return (Get-Content -LiteralPath (Join-Path $script:Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version }
function Package-Hash([string]$Archive) {
  $file=Join-Path $script:Root $Archive
  $expected=((Get-Content -LiteralPath ($file+'.sha256') -Raw) -split '\s+')[0]
  $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -notmatch '^[a-f0-9]{64}$' -or $hash -ne $expected) { throw '部署包校验失败，未上传。' }
  return $hash
}
function Update-Server {
  $archive='release/server/TS-Music-Bot-Server-'+(Version)+'-update.tar.gz'
  $hash=Package-Hash $archive; $id=[Guid]::NewGuid().ToString('N')
  Upload $archive ('tsmd-update-'+$id+'.tar.gz')
  Upload 'deploy/update-ubuntu.sh' ('tsmd-update-'+$id+'.sh')
  Write-Stage '保留现有数据和音频选择，更新服务器代码…' -ConsoleMessage 'Updating server code; retaining data and audio backend...'
  Remote ('bash ~/tsmd-update-'+$id+'.sh ~/tsmd-update-'+$id+'.tar.gz '+$hash)
}
function Install-Browser {
  Write-Stage '首次准备服务器官网登录组件；已安装的组件后续会复用。' -ConsoleMessage 'Preparing the official browser login component; installed files will be reused.'
  Invoke-Native $script:Node @('scripts/prepare-official-browser.mjs') -ShowOutput -Activity 'Preparing the server browser component'
  $browser='release/server/tools/chrome-linux64-155.0.8059.84.zip'
  $browserHash=Package-Hash $browser
  $update='release/server/TS-Music-Bot-Server-'+(Version)+'-update.tar.gz'
  $hash=Package-Hash $update; $id=[Guid]::NewGuid().ToString('N'); $prefix='tsmd-browser-'+$id
  Upload $browser ($prefix+'.zip'); Upload $update ($prefix+'.tar.gz')
  Upload 'deploy/setup-official-browser.sh' ($prefix+'.sh'); Upload 'deploy/update-ubuntu.sh' ($prefix+'-update.sh')
  Upload 'scripts/check-official-browser.mjs' ($prefix+'-check.mjs'); Upload 'src/server/netease-official-browser.mjs' ($prefix+'-adapter.mjs')
  Remote ('bash ~/'+$prefix+'.sh ~/'+$prefix+'.zip '+$browserHash+' ~/'+$prefix+'.tar.gz '+$hash+' ~/'+$prefix+'-update.sh ~/'+$prefix+'-check.mjs ~/'+$prefix+'-adapter.mjs')
}
function Deploy-Server {
  Connect-Settings
  $probe=Probe-Server
  Write-Stage '准备当前版本的完整包和增量包…' -ConsoleMessage 'Preparing the current server packages...'
  Prepare-Project 'server' -Package
  if ($probe.installed) {
    if ($probe.browser) { Update-Server }
    else { Install-Browser }
  } else {
    $archive='release/server/TS-Music-Bot-Server-'+(Version)+'.tar.gz'
    $hash=Package-Hash $archive; $id=[Guid]::NewGuid().ToString('N')
    Upload $archive ('tsmd-install-'+$id+'.tar.gz')
    Write-Stage '首次安装服务器后台；主人密码只在终端显示，请自行保存。' -ConsoleMessage 'Installing the server service. Save the owner password shown below.'
    Remote ('set -eu; archive="$HOME/tsmd-install-'+$id+'.tar.gz"; test "$(sha256sum "$archive" | cut -d" " -f1)" = '+$hash+'; app="$HOME/ts-music-bot-server-'+$id+'"; mkdir "$app"; tar -xzf "$archive" -C "$app"; bash "$app/deploy/preflight.sh"; bash "$app/deploy/install-ubuntu.sh"')
    Install-Browser
  }
  Write-Stage '部署完成。' -ConsoleMessage 'Deployment completed.'
  Open-Console
}
function Quote-Native([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"'+[regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'
}
function Console-Ready([int]$Port) {
  try { $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:'+$Port+'/api/admin/session');$request.Timeout=1000;$response=$request.GetResponse();$status=[int]$response.StatusCode;$response.Close();return ($status -eq 200) }
  catch [Net.WebException] { if ($_.Exception.Response) { $status=[int]$_.Exception.Response.StatusCode;$_.Exception.Response.Close();return ($status -eq 401) }; return $false }
}
function Open-Console {
  if (-not $script:Config) { Connect-Settings }
  $port=[int]$script:Config.consolePort
  if (-not (Console-Ready $port)) {
    $nativeArguments=@($script:SshArgs)+@('-p',[string]$script:Config.port,'-o','ExitOnForwardFailure=yes','-N','-L',($port.ToString()+':127.0.0.1:18080'),[string]$script:Config.target)
    $line=($nativeArguments | ForEach-Object { Quote-Native $_ }) -join ' '
    $process=Start-Process -FilePath $script:Ssh -ArgumentList $line -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $script:Work 'console-tunnel-last.log')
    $ready=$false
    for ($attempt=0;$attempt -lt 40;$attempt++) { if (Console-Ready $port) { $ready=$true;break };if ($process.HasExited) { break };Start-Sleep -Milliseconds 250 }
    if (-not $ready) { throw '管理转发未就绪，请查看 work/deployment/console-tunnel-last.log；不会关闭已有终端。' }
    [IO.File]::WriteAllText((Join-Path $script:Work 'console-tunnel.json'),(@{pid=$process.Id;target=$script:Config.target;port=$port}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  }
  $url='http://127.0.0.1:'+$port+'/admin';Write-Host ('主人控制台：'+$url);Start-Process $url
}
function Fixed-Endpoint {
  Connect-Settings;Ensure-Node
  $probe=Probe-Server; if (-not $probe.installed) { throw '请先使用一键部署。' }
  $ip=$script:Config.target.Split('@')[1]
  $parsed=$null
  if (-not [Net.IPAddress]::TryParse($ip,[ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw '固定入口目前需要服务器公网 IPv4。' }
  Write-Host '请先在云防火墙放行 TCP 80、443。已有 HTTPS 配置会复用。'
  Invoke-Native $script:Node @('scripts/prepare-server-https.mjs') -ShowOutput -Activity 'Preparing the HTTPS component'
  $id=[Guid]::NewGuid().ToString('N')
  Upload 'deploy/enable-fixed-endpoint.sh' ('tsmd-fixed-'+$id+'.sh')
  Upload 'release/server/tools/caddy_2.11.7_linux_amd64.tar.gz' ('tsmd-fixed-'+$id+'.tar.gz')
  Remote ('bash ~/tsmd-fixed-'+$id+'.sh '+$ip+' ~/tsmd-fixed-'+$id+'.tar.gz')
}
function Audio-Transport([string]$Mode) {
  Connect-Settings;Ensure-Node;$id=[Guid]::NewGuid().ToString('N')
  if ($Mode -eq 'official') { Invoke-Native $script:Node @('scripts/prepare-official-audio.mjs') -ShowOutput -Activity 'Preparing the official audio component' }
  Upload 'deploy/official-transport.sh' ('tsmd-audio-'+$id+'.sh')
  if ($Mode -eq 'custom') { Remote ('bash ~/tsmd-audio-'+$id+'.sh --custom');return }
  if ($Mode -eq 'diagnose') { Upload 'scripts/diagnose-server-audio.mjs' ('tsmd-audio-'+$id+'.mjs');Remote ('bash ~/tsmd-audio-'+$id+'.sh --diagnose ~/tsmd-audio-'+$id+'.mjs');return }
  Prepare-Project 'server' -Package
  Remote ('bash ~/tsmd-audio-'+$id+'.sh --archive')
  Update-Server
  Upload 'deploy/sinusbot/tsmd-transport.js' ('tsmd-bridge-'+$id+'.js')
  Upload 'release/server/tools/sinusbot.current.tar.bz2' ('tsmd-audio-'+$id+'.tar.bz2')
  $hash=Package-Hash 'release/server/tools/sinusbot.current.tar.bz2'
  Write-Host '官方 TS3 客户端安装时，请自行阅读许可并在终端选择是否接受。'
  Remote ('bash ~/tsmd-audio-'+$id+'.sh --install ~/tsmd-bridge-'+$id+'.js ~/tsmd-audio-'+$id+'.tar.bz2 '+$hash) -Interactive
}
function Open-LocalRelease {
  $url='https://github.com/Nenki857/teamspeak-music-bot/releases'
  Write-Host '本地版请从 Releases 下载完整 Windows ZIP，解压后运行 TS Music Bot.exe。'
  Write-Host '源码不再自动下载或安装本地运行依赖。'
  Write-Host $url
  Start-Process $url
}
function Show-Menu {
  if ($Edition -eq 'local') { Open-LocalRelease;return }
  while ($true) {
    Write-Host ''
    Write-Host '1 一键部署/更新   2 打开主人控制台   3 查看服务状态   4 重启音乐机器人'
    Write-Host '5 配置固定公网入口   6 音频链路检查   7 切换官方音频   8 恢复原音频'
    Write-Host '9 修改连接设置   P 打包服务器版   0 退出'
    $selection=Read-Host '请选择'
    if ($selection -eq '0') { return }
    try {
      switch ($selection.ToUpperInvariant()) {
        '1' { Deploy-Server } '2' { Connect-Settings;Open-Console }
        '3' { Connect-Settings;Remote 'systemctl is-active ts-music-desk.service; systemctl show ts-music-desk.service -p WorkingDirectory -p ActiveState -p SubState' }
        '4' { Connect-Settings;Remote 'sudo -n /usr/bin/systemctl restart ts-music-desk.service';Open-Console }
        '5' { Fixed-Endpoint } '6' { Audio-Transport 'diagnose' } '7' { Audio-Transport 'official' } '8' { Audio-Transport 'custom' }
        '9' { $null=Read-Settings -Reset; $script:SshArgs=@() } 'P' { Prepare-Project 'server' -Package }
        default { Write-Host '请选择菜单中的项目。' }
      }
    } catch { Write-Host $_.Exception.Message -ForegroundColor Red;Write-Stage '本次操作未完成，修复错误后使用同一入口重试。' }
  }
}
if ($Library) { return }
Set-Location -LiteralPath $script:Root
if ($CheckOnly) { Write-Output (@{edition=$Edition;root=$script:Root;action=$Action;networkAttempted=$false;settingsStoredIn='work/deployment/settings.json'} | ConvertTo-Json -Compress);exit 0 }
try {
  if ($Edition -eq 'local') {
    if ($Action -notin @('default','menu')) { throw '本地版请使用 Releases 完整 ZIP；开发打包请使用 npm run package:win。' }
    Open-LocalRelease;exit 0
  }
  switch ($Action) {
    'default' { Deploy-Server }
    'menu' { Show-Menu }
    'package' { Prepare-Project $Edition -Package }
    'console' { Connect-Settings;Open-Console }
    default { throw '入口参数无效。' }
  }
  exit 0
} catch { Write-Host $_.Exception.Message -ForegroundColor Red;Write-Stage '操作失败；现有数据保留，可重新运行同一入口。';exit 1 }
