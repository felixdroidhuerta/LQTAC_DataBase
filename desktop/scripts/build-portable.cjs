const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const archiver = require('archiver');
const { execFileSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
async function build() {
  if (process.platform !== 'win32') throw new Error('Este paquete portable se genera en Windows.');
  const manifest = require('../package.json');
  const lock = require('../package-lock.json');
  const name = `LQTAC-DataBase-${manifest.version}-win-${process.arch}-portable`;
  // Keep distributables next to the project, like the LQTAC Studio portable builds.
  const directory = path.resolve(desktop, '../..', name);
  // Refuse replacement: an earlier portable build may already contain a user's Data folder.
  await fs.mkdir(directory, { recursive: false }).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory);
  });
  await fs.cp(path.join(desktop, 'node_modules/electron/dist'), directory, { recursive: true });
  await fs.rename(path.join(directory, 'electron.exe'), path.join(directory, 'LQTAC Data Base.exe'));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'set-portable-icon.ps1'), '-Executable', path.join(directory, 'LQTAC Data Base.exe'), '-Icon', path.join(desktop, '../assets/branding/app-icon.ico')], { stdio: 'inherit' });
  const application = path.join(directory, 'resources/app');
  await fs.mkdir(path.join(application, 'desktop'), { recursive: true });
  await fs.cp(path.join(desktop, 'src'), path.join(application, 'desktop/src'), { recursive: true });
  await fs.cp(path.join(desktop, '../assets/branding'), path.join(application, 'assets/branding'), { recursive: true });
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: manifest.name, productName: 'LQTAC Data Base', version: manifest.version, main: 'desktop/src/main.cjs' }, null, 2));
  let packages = 0;
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    if (!relative || metadata.dev) continue;
    const source = path.join(desktop, relative);
    try { await fs.access(source); } catch (error) { if (metadata.optional) continue; throw error; }
    await fs.cp(source, path.join(application, 'desktop', relative), {
      recursive: true,
      filter: file => file === source || path.basename(file) !== 'node_modules'
    });
    packages++;
  }
  await fs.copyFile(path.join(desktop, '../LICENSE.md'), path.join(application, 'LICENSE.md'));
  await fs.writeFile(path.join(directory, 'portable.json'), JSON.stringify({ application: 'LQTAC Data Base', version: manifest.version, dataDirectory: 'Data' }, null, 2));
  await fs.writeFile(path.join(directory, 'LEEME.txt'), `LQTAC Data Base ${manifest.version} - Portable Windows ${process.arch}\r\n\r\nExtrae TODO el ZIP y abre LQTAC Data Base.exe. No necesita Node.js ni instalación.\r\nLas conexiones, borradores y preferencias se guardan en Data junto al ejecutable.\r\nPara trasladarlo, cierra el programa y copia la carpeta completa, incluida Data.\r\nEl paquete se distribuye sin conexiones ni datos personales. No importa la configuración de desarrollo.\r\nLos archivos SQL externos no se trasladan automáticamente; cópialos también si los necesitas.\r\nLas VPN y permisos de acceso al servidor deben estar disponibles en el equipo de destino.\r\nPara actualizar, extrae la nueva versión en otra carpeta y copia allí tu Data con ambas aplicaciones cerradas.\r\nConserva LICENSE, LICENSES.chromium.html y las licencias de las dependencias.\r\n`);
  const manual = path.join(desktop, '../output/pdf', 'LQTAC_DataBase_Manual_de_usuario_0.2.0.pdf');
  await fs.copyFile(manual, path.join(directory, 'Manual-de-usuario-0.2.0.pdf'));
  const archive = directory + '.zip';
  await zip(directory, archive, name);
  console.log(JSON.stringify({ directory, archive, packages }, null, 2));
}
async function zip(directory, archive, name) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(archive, { flags: 'wx' });
    const bundle = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve); output.on('error', reject); bundle.on('error', reject); bundle.on('warning', reject);
    bundle.pipe(output); bundle.directory(directory, name); bundle.finalize();
  });
}
module.exports = { zip };
if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
