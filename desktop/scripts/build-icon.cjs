const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(() => {
  const directory = path.resolve(__dirname, '../../assets/branding');
  const source = nativeImage.createFromPath(path.join(directory, 'app-icon.png'));
  if (source.isEmpty()) throw new Error('No se pudo abrir el icono.');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  fs.writeFileSync(path.join(directory, 'app-icon.ico'), Buffer.concat([header, ...frames]));
  console.log(`Icono generado: ${source.getSize().width}×${source.getSize().height}; ICO con ${sizes.length} tamaños.`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
