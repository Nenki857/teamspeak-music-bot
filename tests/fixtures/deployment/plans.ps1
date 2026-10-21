$script:trace=[Collections.Generic.List[string]]::new()
function Connect-Settings { $script:Config=[pscustomobject]@{target='ubuntu@example.test'} }
function Probe-Server { return $script:probe }
function Prepare-Project { param($Mode,[switch]$Package);$script:trace.Add('prepare') }
function Update-Server { $script:trace.Add('update') }
function Install-Browser { $script:trace.Add('browser') }
function Open-Console { $script:trace.Add('console') }
function Write-Stage { param($Message) }
function Version { return '1.2.0' }
function Package-Hash { param($Archive); return ('a'*64) }
function Upload { param($Source,$RemoteName);$script:trace.Add('upload') }
function Remote { param($Command);$script:trace.Add('install') }
$script:probe=@{installed=$true;browser=$true};Deploy-Server;$existing=@($script:trace.ToArray());$script:trace.Clear()
$script:probe=@{installed=$true;browser=$false};Deploy-Server;$missingBrowser=@($script:trace.ToArray());$script:trace.Clear()
$script:probe=@{installed=$false;browser=$false};Deploy-Server;$fresh=@($script:trace.ToArray());$script:trace.Clear()
function Probe-Server { throw 'synthetic failure' }
try { Deploy-Server } catch {}
@{existing=$existing;missingBrowser=$missingBrowser;fresh=$fresh;afterFailure=@($script:trace.ToArray())}|ConvertTo-Json -Compress
