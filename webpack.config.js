const path = require('path');

module.exports = {
  entry: './src/smart-water-controller-schedule-card.js',
  mode: 'production',
  output: {
    filename: 'smart-water-controller-schedule-card.js',
    path: path.resolve(__dirname)
  }
};