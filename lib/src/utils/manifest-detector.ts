import { existsSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

const logger = new Logger('manifest-detector');

const PYTHON_PACKAGE_MAP: Record<string, string> = {
  django: 'django',
  fastapi: 'fastapi',
  flask: 'flask',
  sqlalchemy: 'sqlalchemy',
  pydantic: 'pydantic',
  pytest: 'pytest',
};

function matchPythonPackage(depName: string): string | undefined {
  const normalized = depName.trim().toLowerCase().replace(/[_-]/g, '');
  for (const [pkg, lib] of Object.entries(PYTHON_PACKAGE_MAP)) {
    if (normalized === pkg) {
      return lib;
    }
  }
  return undefined;
}

/**
 * Detect Python libraries from pyproject.toml and requirements.txt in the given directory.
 *
 * @param rootDir - Path to the project root directory to scan for manifest files.
 * @returns Array of canonical library identifiers found in the manifests.
 */
export function detectPythonLibraries(rootDir: string): string[] {
  const libs = new Set<string>();

  // pyproject.toml
  try {
    const pyprojectPath = path.join(rootDir, 'pyproject.toml');
    if (existsSync(pyprojectPath)) {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const lines = content.split('\n');
      let inPoetryDeps = false;
      let inProjectSection = false;
      let inProjectDepsArray = false;
      let inOptDepsSection = false;

      for (const line of lines) {
        const trimmed = line.trim();

        // Track section headers
        if (trimmed.startsWith('[')) {
          inProjectDepsArray = false;

          if (
            trimmed.startsWith('[tool.poetry.dependencies]') ||
            trimmed.startsWith('[tool.poetry.dev-dependencies]')
          ) {
            inPoetryDeps = true;
            inProjectSection = false;
            inOptDepsSection = false;
            continue;
          }
          if (trimmed.startsWith('[project]')) {
            inProjectSection = true;
            inPoetryDeps = false;
            inOptDepsSection = false;
            continue;
          }
          if (trimmed.startsWith('[project.optional-dependencies]')) {
            inOptDepsSection = true;
            inProjectSection = false;
            inPoetryDeps = false;
            continue;
          }
          // Any other section ends current context
          inPoetryDeps = false;
          inProjectSection = false;
          inOptDepsSection = false;
          continue;
        }

        // Continue multi-line array (PEP 621 dependencies)
        if (inProjectDepsArray) {
          if (trimmed.includes(']')) {
            inProjectDepsArray = false;
          }
          extractArrayPackages(trimmed, libs);
          continue;
        }

        // Poetry: key = "version" style
        if (inPoetryDeps) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const pkgName = trimmed.substring(0, eqIdx).trim().replace(/["']/g, '');
            const lib = matchPythonPackage(pkgName);
            if (lib) libs.add(lib);
          }
          continue;
        }

        // PEP 621 [project]: dependencies = ["pkg>=1.0", ...]
        if (inProjectSection) {
          const depsMatch = trimmed.match(/^dependencies\s*=\s*\[(.*)/);
          if (depsMatch) {
            inProjectDepsArray = true;
            const rest = depsMatch[1];
            extractArrayPackages(rest, libs);
            if (rest.includes(']')) {
              inProjectDepsArray = false;
            }
          }
          continue;
        }

        // PEP 621 [project.optional-dependencies]: extra = ["pkg>=1.0", ...]
        if (inOptDepsSection) {
          const optDepsMatch = trimmed.match(/^[a-zA-Z0-9_-]+\s*=\s*\[(.*)/);
          if (optDepsMatch) {
            const rest = optDepsMatch[1];
            extractArrayPackages(rest, libs);
          }
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to parse pyproject.toml', { error: sanitizeErrorForLog(error) });
  }

  // requirements.txt
  try {
    const reqPath = path.join(rootDir, 'requirements.txt');
    if (existsSync(reqPath)) {
      const content = readFileSync(reqPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        const pkgName = trimmed
          .split(/[><=~!]+/)[0]
          ?.trim()
          .split(/\[.*?\]/)[0]
          ?.trim();
        if (pkgName) {
          const lib = matchPythonPackage(pkgName);
          if (lib) libs.add(lib);
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to parse requirements.txt', { error: sanitizeErrorForLog(error) });
  }

  return [...libs];
}

/**
 * Extract package names from a TOML array string fragment like '"fastapi>=0.100", "sqlalchemy"'.
 * @param fragment
 * @param libs
 */
function extractArrayPackages(fragment: string, libs: Set<string>): void {
  const pkgMatches = fragment.matchAll(/["']([^"']+)["']/g);
  for (const match of pkgMatches) {
    const depSpec = match[1];
    // PEP 508: extract package name before any version specifier or extras
    const pkgName = depSpec.split(/[;><=~!\[]/)[0]?.trim();
    if (pkgName) {
      const lib = matchPythonPackage(pkgName);
      if (lib) libs.add(lib);
    }
  }
}

function sanitizeErrorForLog(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const JAVA_ARTIFACT_MAP: Record<string, string> = {
  'spring-boot': 'spring-boot',
  'spring-boot-starter': 'spring-boot',
  'hibernate-core': 'hibernate',
  quarkus: 'quarkus',
  micronaut: 'micronaut',
  'micronaut-inject': 'micronaut',
};

/**
 * Detect Java/Kotlin libraries from pom.xml and build.gradle files in the given directory.
 *
 * @param rootDir - Path to the project root directory to scan for manifest files.
 * @returns Array of canonical library identifiers found in the manifests.
 */
export function detectJavaLibraries(rootDir: string): string[] {
  const libs = new Set<string>();

  // pom.xml
  try {
    const pomPath = path.join(rootDir, 'pom.xml');
    if (existsSync(pomPath)) {
      const content = readFileSync(pomPath, 'utf-8');
      const artifactMatches = content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g);
      for (const match of artifactMatches) {
        const artifactId = match[1].trim();
        for (const [pattern, lib] of Object.entries(JAVA_ARTIFACT_MAP)) {
          if (
            artifactId === pattern ||
            artifactId.startsWith(pattern + '-') ||
            artifactId.startsWith(pattern + '.')
          ) {
            libs.add(lib);
          }
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to parse pom.xml', { error: sanitizeErrorForLog(error) });
  }

  // build.gradle / build.gradle.kts
  try {
    const gradleFiles = ['build.gradle', 'build.gradle.kts'];
    for (const gradleFile of gradleFiles) {
      const gradlePath = path.join(rootDir, gradleFile);
      if (existsSync(gradlePath)) {
        const content = readFileSync(gradlePath, 'utf-8');
        // Gradle Groovy DSL: implementation 'group:artifact:version'
        const groovyMatches = content.matchAll(
          /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s+['"]([^:'"]+):([^:'"]+)/g,
        );
        for (const match of groovyMatches) {
          const artifactId = match[2].trim();
          for (const [pattern, lib] of Object.entries(JAVA_ARTIFACT_MAP)) {
            if (
              artifactId === pattern ||
              artifactId.startsWith(pattern + '-') ||
              artifactId.startsWith(pattern + '.')
            ) {
              libs.add(lib);
            }
          }
        }
        // Gradle Kotlin DSL: implementation("group:artifact:version")
        const kotlinMatches = content.matchAll(
          /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\([\s\S]*?['"]([^:'"]+):([^:'"]+)/g,
        );
        for (const match of kotlinMatches) {
          const artifactId = match[2].trim();
          for (const [pattern, lib] of Object.entries(JAVA_ARTIFACT_MAP)) {
            if (
              artifactId === pattern ||
              artifactId.startsWith(pattern + '-') ||
              artifactId.startsWith(pattern + '.')
            ) {
              libs.add(lib);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to parse build.gradle files', { error: sanitizeErrorForLog(error) });
  }

  return [...libs];
}

const RUBY_GEM_MAP: Record<string, string> = {
  rails: 'rails',
  sinatra: 'sinatra',
  rspec: 'rspec',
  'rspec-rails': 'rspec',
};

/**
 * Detect Ruby libraries from Gemfile in the given directory.
 *
 * @param rootDir - Path to the project root directory to scan for manifest files.
 * @returns Array of canonical library identifiers found in the Gemfile.
 */
export function detectRubyLibraries(rootDir: string): string[] {
  const libs = new Set<string>();

  try {
    const gemfilePath = path.join(rootDir, 'Gemfile');
    if (existsSync(gemfilePath)) {
      const content = readFileSync(gemfilePath, 'utf-8');
      const gemMatches = content.matchAll(/gem\s+['"]([^'"]+)['"]/g);
      for (const match of gemMatches) {
        const gemName = match[1].trim();
        for (const [pattern, lib] of Object.entries(RUBY_GEM_MAP)) {
          if (gemName === pattern) {
            libs.add(lib);
          }
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to parse Gemfile', { error: sanitizeErrorForLog(error) });
  }

  return [...libs];
}

const DOTNET_PACKAGE_MAP: Record<string, string> = {
  'Microsoft.AspNetCore': 'Microsoft.AspNetCore',
  EntityFramework: 'EntityFramework',
  'Microsoft.EntityFrameworkCore': 'EntityFramework',
};

/**
 * Detect .NET libraries from .csproj files in the given directory (recursively).
 *
 * @param rootDir - Path to the project root directory to scan for .csproj files.
 * @returns Array of canonical library identifiers found in project references.
 */
export function detectDotnetLibraries(rootDir: string): string[] {
  const libs = new Set<string>();

  if (!existsSync(rootDir)) return [];

  try {
    const entries = readdirSync(rootDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.csproj')) {
        const csprojPath = path.join(entry.parentPath, entry.name);
        try {
          const content = readFileSync(csprojPath, 'utf-8');
          const packageMatches = content.matchAll(
            /<PackageReference\s+Include\s*=\s*['"]([^'"]+)['"]/g,
          );
          for (const match of packageMatches) {
            const pkgName = match[1].trim();
            for (const [pattern, lib] of Object.entries(DOTNET_PACKAGE_MAP)) {
              if (pkgName === pattern || pkgName.startsWith(pattern + '.')) {
                libs.add(lib);
              }
            }
          }
        } catch (error) {
          logger.warn('Failed to parse .csproj file', {
            file: csprojPath,
            error: sanitizeErrorForLog(error),
          });
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to scan directory for .csproj files', {
      dir: rootDir,
      error: sanitizeErrorForLog(error),
    });
  }

  return [...libs];
}
