module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  collectCoverageFrom: [
    '*.js',
    '!build.js',
    '!jest.config.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/test-setup.js']
};
