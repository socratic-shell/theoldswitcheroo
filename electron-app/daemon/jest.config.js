module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    '*.ts',
    '!build.js',
    '!jest.config.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/test-setup.js']
};
