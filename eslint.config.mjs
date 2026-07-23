import tsParser from '@typescript-eslint/parser';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
  {
    files: ['**/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      jsdoc,
    },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ArrowFunctionExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ClassExpression: true,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSMethodSignature',
            'TSPropertySignature',
            'MethodDefinition',
            'PropertyDefinition',
          ],
        },
      ],
      'jsdoc/require-param': [
        'error',
        {
          contexts: [
            'ArrowFunctionExpression',
            'FunctionDeclaration',
            'FunctionExpression',
            'MethodDefinition',
            'TSMethodSignature',
          ],
        },
      ],
      'jsdoc/require-param-description': [
        'error',
        {
          contexts: [
            'ArrowFunctionExpression',
            'FunctionDeclaration',
            'FunctionExpression',
            'MethodDefinition',
            'TSMethodSignature',
          ],
        },
      ],
      'jsdoc/require-returns': [
        'error',
        {
          contexts: [
            'ArrowFunctionExpression',
            'FunctionDeclaration',
            'FunctionExpression',
            'MethodDefinition',
            'TSMethodSignature',
          ],
        },
      ],
      'jsdoc/require-returns-description': [
        'error',
        {
          contexts: [
            'ArrowFunctionExpression',
            'FunctionDeclaration',
            'FunctionExpression',
            'MethodDefinition',
            'TSMethodSignature',
          ],
        },
      ],
    },
  },
];
