$ErrorActionPreference = 'Stop'
$desktop = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$root = (Resolve-Path -LiteralPath (Join-Path $desktop '..')).Path
$dist = Join-Path $desktop 'node_modules\electron\dist'
$source = Join-Path $dist 'electron.exe'
$target = Join-Path $dist 'LQTAC dbFox Desarrollo.exe'
$shortcut = Join-Path $root 'LQTAC dbFox Desarrollo.lnk'
$icon = Join-Path $root 'assets\branding\app-icon.ico'
if (-not (Test-Path -LiteralPath $source)) { throw 'Falta Electron. Instala primero las dependencias del proyecto.' }

# Keep the development executable beside Electron's libraries; the shortcut supplies the project path.
Copy-Item -LiteralPath $source -Destination $target -Force
& (Join-Path $PSScriptRoot 'set-portable-icon.ps1') -Executable $target -Icon $icon
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $target
$link.Arguments = '"' + $desktop + '"'
$link.WorkingDirectory = $desktop
$link.IconLocation = "$target,0"
$link.Description = 'LQTAC dbFox - versión de desarrollo'
$link.Save()

# Match Electron's AppUserModelID so a pinned shortcut groups with its window.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LqtacShortcutIdentity {
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr value; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count); void GetAt(uint index, out PROPERTYKEY key);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT value); void Commit();
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bind, uint flags, ref Guid iid, out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT value);
  public static void Set(string path) {
    Guid iid = typeof(IPropertyStore).GUID; IPropertyStore store;
    SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,2,ref iid,out store);
    var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid=5 };
    var value = new PROPVARIANT { vt=31, value=Marshal.StringToCoTaskMemUni("LQTAC.DataBase") };
    try { store.SetValue(ref key,ref value); store.Commit(); }
    finally { PropVariantClear(ref value); Marshal.ReleaseComObject(store); }
  }
}
'@
[LqtacShortcutIdentity]::Set($shortcut)
Write-Host "Acceso directo creado: $shortcut"
