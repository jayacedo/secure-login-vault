param([Parameter(Mandatory=$true)][string]$XpiPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($XpiPath)
try {
    $entries = @()
    $manifest = $null
    foreach ($entry in $archive.Entries) {
        if ($entry.Length -gt 2097152) { throw 'Oversized XPI entry' }
        $stream = $entry.Open()
        try {
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $digest = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
            finally { $hash.Dispose() }
        } finally { $stream.Dispose() }
        $entries += @{ name = $entry.FullName; sha256 = $digest }
        if ($entry.FullName -eq 'manifest.json') {
            $reader = [IO.StreamReader]::new($entry.Open())
            try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
            finally { $reader.Dispose() }
        }
    }
    @{ entries = $entries; manifest = $manifest } | ConvertTo-Json -Depth 20 -Compress
} finally { $archive.Dispose() }
