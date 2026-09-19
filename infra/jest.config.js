module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  collectCoverageFrom: ['lib/**/*.ts', '!**/*.d.ts'],
  coverageThreshold: {
    global: { lines: 70, branches: 70, functions: 70, statements: 70 },
  },
};
