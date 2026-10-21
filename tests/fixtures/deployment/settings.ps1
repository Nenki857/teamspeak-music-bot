$key=Join-Path (Get-Location) 'work/synthetic-key-path'
[IO.File]::WriteAllText($key,'synthetic only')
$settings=[pscustomobject]@{target='ubuntu@example.test';port=22;fingerprint=('SHA256:'+('A'*43));keyFiles=@($key);consolePort=18080}
Assert-Settings $settings
$settings.target='ubuntu@example.test;whoami';$rejected=$false
try { Assert-Settings $settings } catch { $rejected=$true }
Remove-Item -LiteralPath $key
@{rejected=$rejected}|ConvertTo-Json -Compress
