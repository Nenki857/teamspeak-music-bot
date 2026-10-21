param([uri]$Uri,[string]$Destination,[string]$Label='Component')
$ErrorActionPreference='Stop'
try {
  . (Join-Path $PSScriptRoot 'manage.ps1') -Library
  Receive-File -Uri $Uri -Destination $Destination -Label $Label -ConnectTimeoutSeconds 30 -IdleTimeoutSeconds 30 -TimeoutSeconds 180
  exit 0
} catch {
  Write-Host ('[Download] '+$_.Exception.GetBaseException().Message)
  exit 1
}
