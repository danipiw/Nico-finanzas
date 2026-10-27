import fs from 'fs';
const p = 'C:\\Users\\Danipiw\\Desktop\\Proyectos\\nico_finanza - v2\\finanzas-nico\\src\\App.jsx';
let c = fs.readFileSync(p, 'utf8');
const old = 'const threshold = 250;';
const newC = 'const threshold = 400;';
if (c.includes(old)) {
  c = c.replace(old, newC);
  fs.writeFileSync(p, c);
  console.log('Threshold ajustado a 400px');
} else {
  console.log('No se encontró el patrón');
}