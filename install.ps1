#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Repo = "itskhalil/talky"
$AppName = "Talky"

# Detect architecture
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($Arch) {
    "X64" { $ArchPattern = "x64" }
    "Arm64" { $ArchPattern = "arm64" }
    default {
        Write-Error "Unsupported architecture: $Arch"
        exit 1
    }
}

Write-Host "Detected architecture: $ArchPattern"

$DownloadUrl = "https://github.com/$Repo/releases/latest/download/Talky_${ArchPattern}-setup.exe"
$InstallerPath = Join-Path $env:TEMP "Talky-setup.exe"

Write-Host "Downloading $AppName from $DownloadUrl..."
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "Error: Failed to download $AppName."
    Write-Host "This could mean:"
    Write-Host "  - No release is available yet"
    Write-Host "  - The installer for your architecture ($ArchPattern) is missing"
    Write-Host "  - Network connectivity issues"
    Write-Host ""
    Write-Host "Check releases at: https://github.com/$Repo/releases"
    exit 1
}

Write-Host "Removing security restrictions..."
Unblock-File -Path $InstallerPath

Write-Host "Running installer..."
Start-Process -FilePath $InstallerPath -Wait

Write-Host "Cleaning up..."
Remove-Item $InstallerPath -Force

Write-Host "Done! $AppName has been installed."
