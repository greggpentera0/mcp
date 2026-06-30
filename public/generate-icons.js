import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

function createIconSVG(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mcpLogoGradient" x1="42" y1="34" x2="218" y2="224" gradientUnits="userSpaceOnUse">
      <stop stop-color="#2F7BFF"/>
      <stop offset="1" stop-color="#0D4FE8"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="54" fill="url(#mcpLogoGradient)"/>
  <g stroke="#FFFFFF" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M73 100L128 68L183 100L128 132L73 100Z"/>
    <path d="M73 100V157L128 189L183 157V100"/>
    <path d="M128 132V189"/>
    <path d="M92 123L79 136L92 149"/>
    <path d="M111 119L102 153"/>
    <path d="M119 123L132 136L119 149"/>
    <path d="M151 120V155L178 137L151 120Z"/>
  </g>
</svg>
`;
}

sizes.forEach((size) => {
  const svgContent = createIconSVG(size);
  const filename = `icon-${size}x${size}.svg`;
  const filepath = path.join(__dirname, 'icons', filename);

  fs.writeFileSync(filepath, svgContent);
  console.log(`Created ${filename}`);
});

console.log('\nMCP Playground SVG icons created. To convert to PNG, you can use:');
console.log('1. Online converter like cloudconvert.com');
console.log('2. If you have ImageMagick: convert icon.svg icon.png');
console.log('3. If you have Inkscape: inkscape --export-type=png icon.svg');
