module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // Transpile only: type-checking aws-cdk-lib in every worker exhausts memory on
    // small build hosts. Types are checked separately with `tsc --noEmit`.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }]
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
