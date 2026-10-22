const path = require('path');

module.exports = {
  entry: './src/smart-water-controller-schedule-card.js',
  mode: 'production',
  output: {
    filename: 'smart-water-controller-schedule-card.js',
    // Writes into dist/, not the repository root. The root file is the unified
    // HACS bundle that scripts/build.js produces from four sources: when
    // webpack wrote there too, running `npm run build` or `npm run watch`
    // replaced that bundle with the schedule card alone and the overview,
    // zones and style cards silently disappeared from the release.
    path: path.resolve(__dirname, 'dist')
  }
};