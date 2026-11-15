param([switch]$Browser)
$ErrorActionPreference = 'Stop'
try {
    $slvProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $slvElectron = Join-Path $slvProject 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $slvElectron -PathType Leaf)) { throw 'Project Electron runtime is missing. Ask Codex to prepare SLV Test again.' }
    if ($Browser) {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $slvElectron (Join-Path $PSScriptRoot 'slv-test-browser.js')
        if ($LASTEXITCODE -ne 0) { throw 'Could not open the isolated browser. Start SLV Test first; a system-installed Brave, Chrome or Edge is required.' }
    } else {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        $slvScript = Join-Path $PSScriptRoot 'slv-test-app.js'
        Start-Process -FilePath $slvElectron -ArgumentList @('"' + $slvScript + '"') -WorkingDirectory $slvProject -WindowStyle Hidden
    }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'SLV Test stopped')
    exit 1
}
