$ErrorActionPreference = 'Stop'
$lqtacExecutable = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $lqtacExecutable)) {
    Write-Host 'Falta instalar Electron. Desde desktop ejecuta: npm ci; npx install-electron' -ForegroundColor Yellow
    exit 1
}
# Electron must run as a desktop application even when launched from a Node host.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $lqtacExecutable -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot
