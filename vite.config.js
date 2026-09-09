import { defineConfig } from 'vite';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';

// Official Cornerstone3D v3 Vite configuration
// Reference: https://www.cornerstonejs.org/docs/getting-started/vue-angular-react-etc/
export default defineConfig({
  plugins: [
    // Required for dicom-parser (CommonJS module)
    viteCommonjs(),
  ],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'esnext',
  },
});
