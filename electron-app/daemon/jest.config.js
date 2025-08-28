export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    '*.ts',
    '!build.ts',
    '!jest.config.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/test-setup.js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true
    }]
  }
};
