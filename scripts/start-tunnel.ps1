$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cloudflared = Join-Path $projectRoot ".data\cloudflared.exe"
$downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot ".data") | Out-Null

if (!(Test-Path $cloudflared)) {
  Write-Host "Downloading cloudflared..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflared
}

Write-Host "Starting tunnel to http://localhost:8787"
Write-Host "Copy the trycloudflare.com URL that appears below and open it on your phone."
& $cloudflared tunnel --url http://localhost:8787
