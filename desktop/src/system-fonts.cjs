const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

async function listSystemFonts() {
  if (process.platform !== 'win32') throw new Error('La lista de fuentes del sistema está disponible en Windows.');
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; $fonts=[System.Drawing.Text.InstalledFontCollection]::new(); try { ConvertTo-Json -Compress -InputObject @($fonts.Families | ForEach-Object { $_.Name }) } finally { $fonts.Dispose() }';
  const { stdout } = await exec('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide:true, timeout:15000, maxBuffer:2_000_000, encoding:'utf8' });
  const names=JSON.parse(stdout.replace(/^\uFEFF/,''));
  if (!Array.isArray(names)) throw new Error('No se pudieron leer las fuentes instaladas.');
  return [...new Set(names.filter(name=>typeof name==='string'&&name.length>0&&name.length<=200&&!/[\u0000-\u001f\u007f]/.test(name)))].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));
}
module.exports={listSystemFonts};
