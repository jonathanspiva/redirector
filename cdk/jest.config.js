module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts'
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  // Recycle workers that grow past 1 GB (aws-cdk-lib type-checking is memory-heavy)
  workerIdleMemoryLimit: '1GB',
};
