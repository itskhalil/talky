$ErrorActionPreference = "Stop"

$Repo = "itskhalil/talky"
$AppName = "Talky"

# Detect architecture (using env var for PowerShell 5.1 compatibility)
$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $ArchPattern = "x64" }
    "ARM64" { $ArchPattern = "arm64" }
    default {
        Write-Error "Unsupported architecture: $Arch"
        return
    }
}

Write-Host "Detected architecture: $ArchPattern"

# Force TLS 1.2 (Windows PowerShell 5.1 defaults to TLS 1.0, GitHub requires 1.2)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$DownloadUrl = "https://github.com/$Repo/releases/latest/download/Talky_${ArchPattern}-setup.exe"
$InstallerPath = Join-Path $env:TEMP "Talky-setup.exe"

Write-Host "Downloading $AppName from $DownloadUrl..."
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "Error: Failed to download $AppName."
    Write-Host "This could mean:"
    Write-Host "  - The installer for your architecture ($ArchPattern) is missing"
    Write-Host "  - Network connectivity issues"
    Write-Host ""
    Write-Host "Check releases at: https://github.com/$Repo/releases"
    return
}

Write-Host "Removing security restrictions..."
Unblock-File -Path $InstallerPath

Write-Host "Running installer..."
Start-Process -FilePath $InstallerPath -Wait

Write-Host "Cleaning up..."
Remove-Item $InstallerPath -Force

Write-Host "Done! $AppName has been installed."
