[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('StartMenu', 'Desktop', 'Both')]
  [string] $Destination = 'StartMenu',

  [string] $StartMenuDirectory,
  [string] $DesktopDirectory,

  [ValidateNotNullOrEmpty()]
  [string] $ShortcutName = 'Computer Harness Pi'
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Windows Start Menu/Desktop shortcuts can only be installed on Windows.'
}

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$harnessScript = [IO.Path]::GetFullPath((Join-Path $repoRoot 'scripts\harness.ps1'))
if (-not (Test-Path -LiteralPath $harnessScript -PathType Leaf)) {
  throw "Repository launcher was not found: $harnessScript"
}

if ([string]::IsNullOrWhiteSpace($StartMenuDirectory)) {
  $StartMenuDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'Microsoft\Windows\Start Menu\Programs'
}
if ([string]::IsNullOrWhiteSpace($DesktopDirectory)) {
  $DesktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
}

$selectedDestinations = switch ($Destination) {
  'StartMenu' { @(@{ Label = 'Start Menu'; Directory = $StartMenuDirectory }); break }
  'Desktop' { @(@{ Label = 'Desktop'; Directory = $DesktopDirectory }); break }
  'Both' {
    @(
      @{ Label = 'Start Menu'; Directory = $StartMenuDirectory },
      @{ Label = 'Desktop'; Directory = $DesktopDirectory }
    )
    break
  }
}

$invalidFileNameChars = [IO.Path]::GetInvalidFileNameChars()
if ($ShortcutName.IndexOfAny($invalidFileNameChars) -ge 0) {
  throw 'ShortcutName must be a single file name without path separators or invalid filename characters.'
}

$shortcutPaths = @(
  foreach ($entry in $selectedDestinations) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Directory)) { throw "$($entry.Label) destination directory is unavailable." }
    $directory = [IO.Path]::GetFullPath([string]$entry.Directory)
    [pscustomobject]@{
      Label = [string]$entry.Label
      Directory = $directory
      Link = Join-Path $directory "$ShortcutName.lnk"
    }
  }
)
$uniqueLinkPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($shortcut in $shortcutPaths) {
  if (-not $uniqueLinkPaths.Add($shortcut.Link)) {
    throw 'StartMenuDirectory and DesktopDirectory resolve to the same location; choose distinct destinations.'
  }
}

# Check every destination before creating either shortcut, so a collision in
# one selected location cannot silently leave a partial "Both" installation.
foreach ($shortcut in $shortcutPaths) {
  if (Test-Path -LiteralPath $shortcut.Link) {
    throw "Shortcut already exists and will not be overwritten: $($shortcut.Link)"
  }
}

$powerShellExecutable = (Get-Process -Id $PID).Path
if ([string]::IsNullOrWhiteSpace($powerShellExecutable) -or -not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) {
  throw 'Could not resolve the current PowerShell executable for the shortcut target.'
}

$arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$harnessScript`" start"
# Use IShellLinkW directly: repository paths can contain Chinese, and a shell
# shortcut written through an ANSI round-trip can corrupt those path segments.
if ($null -eq ('HarnessShortcutNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport]
[Guid("000214F9-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IHarnessShellLinkW
{
    [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int maxPath, IntPtr findData, uint flags);
    [PreserveSig] int GetIDList(out IntPtr itemIdList);
    [PreserveSig] int SetIDList(IntPtr itemIdList);
    [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
    [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int maxPath);
    [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
    [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int maxPath);
    [PreserveSig] int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
    [PreserveSig] int GetHotkey(out short hotkey);
    [PreserveSig] int SetHotkey(short hotkey);
    [PreserveSig] int GetShowCmd(out int showCommand);
    [PreserveSig] int SetShowCmd(int showCommand);
    [PreserveSig] int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maxPath, out int iconIndex);
    [PreserveSig] int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
    [PreserveSig] int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    [PreserveSig] int Resolve(IntPtr window, uint flags);
    [PreserveSig] int SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}

[ComImport]
[Guid("0000010B-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IHarnessPersistFile
{
    [PreserveSig] int GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    [PreserveSig] int GetCurFile(out IntPtr fileName);
}

public static class HarnessShortcutNative
{
    private static readonly Guid ShellLinkClassId = new Guid("00021401-0000-0000-C000-000000000046");
    private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }

    public static void Create(string fileName, string targetPath, string arguments, string workingDirectory, string description)
    {
        var link = (IHarnessShellLinkW)Activator.CreateInstance(Type.GetTypeFromCLSID(ShellLinkClassId));
        try
        {
            Check(link.SetPath(targetPath));
            Check(link.SetArguments(arguments));
            Check(link.SetWorkingDirectory(workingDirectory));
            Check(link.SetDescription(description));
            Check(link.SetShowCmd(1));
            Check(((IHarnessPersistFile)link).Save(fileName, true));
        }
        finally
        {
            if (Marshal.IsComObject(link)) Marshal.FinalReleaseComObject(link);
        }
    }

    public static string[] Read(string fileName)
    {
        var link = (IHarnessShellLinkW)Activator.CreateInstance(Type.GetTypeFromCLSID(ShellLinkClassId));
        try
        {
            Check(((IHarnessPersistFile)link).Load(fileName, 0));
            var target = new StringBuilder(32768);
            var workingDirectory = new StringBuilder(32768);
            var arguments = new StringBuilder(32768);
            Check(link.GetPath(target, target.Capacity, IntPtr.Zero, 4));
            Check(link.GetWorkingDirectory(workingDirectory, workingDirectory.Capacity));
            Check(link.GetArguments(arguments, arguments.Capacity));
            return new[] { target.ToString(), workingDirectory.ToString(), arguments.ToString() };
        }
        finally
        {
            if (Marshal.IsComObject(link)) Marshal.FinalReleaseComObject(link);
        }
    }
}
'@
}
$createdLinks = [System.Collections.Generic.List[string]]::new()
$temporaryLinks = [System.Collections.Generic.List[string]]::new()
try {
  foreach ($shortcut in $shortcutPaths) {
    if (-not $PSCmdlet.ShouldProcess($shortcut.Link, "Create $($shortcut.Label) terminal shortcut")) { continue }
    if (-not (Test-Path -LiteralPath $shortcut.Directory -PathType Container)) {
      New-Item -ItemType Directory -Force -Path $shortcut.Directory | Out-Null
    }

    $temporaryLink = Join-Path $shortcut.Directory ('.harness-shortcut-' + [Guid]::NewGuid().ToString('N') + '.lnk')
    $temporaryLinks.Add($temporaryLink)
    [HarnessShortcutNative]::Create(
      $temporaryLink,
      $powerShellExecutable,
      $arguments,
      $repoRoot,
      'Open the Computer Harness Pi interactive terminal TUI.'
    )

    # File.Move is deliberately used instead of Save() at the final path: it
    # fails if another file appeared after the preflight check.
    [IO.File]::Move($temporaryLink, $shortcut.Link)
    $temporaryLinks.Remove($temporaryLink)
    $createdLinks.Add($shortcut.Link)
    Write-Output "Created $($shortcut.Label) shortcut: $($shortcut.Link)"
  }
} catch {
  foreach ($createdLink in $createdLinks) {
    if (Test-Path -LiteralPath $createdLink -PathType Leaf) { Remove-Item -LiteralPath $createdLink -Force }
  }
  throw
} finally {
  foreach ($temporaryLink in $temporaryLinks) {
    if (Test-Path -LiteralPath $temporaryLink -PathType Leaf) { Remove-Item -LiteralPath $temporaryLink -Force }
  }
}
