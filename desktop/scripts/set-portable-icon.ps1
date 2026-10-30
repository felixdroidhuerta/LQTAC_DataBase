param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class PortableIcon {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EndUpdateResource(IntPtr h, bool discard);
  static void Put(IntPtr h, int type, int id, byte[] data) { if(!UpdateResource(h,(IntPtr)type,(IntPtr)id,0,data,(uint)data.Length)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Apply(string exe, string icon) {
    byte[] ico=File.ReadAllBytes(icon);
    if(ico.Length<6 || BitConverter.ToUInt16(ico,0)!=0 || BitConverter.ToUInt16(ico,2)!=1) throw new InvalidDataException("Archivo ICO no válido.");
    int count=BitConverter.ToUInt16(ico,4); if(count<1 || ico.Length<6+16*count) throw new InvalidDataException("Archivo ICO incompleto.");
    var group=new byte[6+14*count]; Array.Copy(ico,group,6);
    IntPtr h=BeginUpdateResource(exe,false); if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    bool done=false;
    try {
      for(int i=0;i<count;i++) {
        int src=6+16*i, dst=6+14*i; uint size=BitConverter.ToUInt32(ico,src+8), offset=BitConverter.ToUInt32(ico,src+12);
        if(size==0 || (long)offset+size>ico.Length) throw new InvalidDataException("Imagen ICO incompleta.");
        var data=new byte[size]; Array.Copy(ico,offset,data,0,size); Put(h,3,i+1,data);
        Array.Copy(ico,src,group,dst,12); group[dst+12]=(byte)(i+1); group[dst+13]=(byte)((i+1)>>8);
      }
      Put(h,14,1,group); if(!EndUpdateResource(h,false)) throw new Win32Exception(Marshal.GetLastWin32Error()); done=true;
    } finally { if(!done) EndUpdateResource(h,true); }
  }
}
'@
[PortableIcon]::Apply((Resolve-Path -LiteralPath $Executable).Path, (Resolve-Path -LiteralPath $Icon).Path)
