import { existsSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';

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
    if (normalized === pkg || normalized === pkg.replace(/[_-]/g, '')) {
      return lib;
    }
  }
  return undefined;
}

export function detectPythonLibraries(rootDir: string): string[] {
  const libs = new Set<string>();

  // pyproject.toml
  try {
    const pyprojectPath = path.join(rootDir, 'pyproject.toml');
    if (existsSync(pyprojectPath)) {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const lines = content.split('\n');
      let inDepsSection = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('[tool.poetry.dependencies]') ||
          trimmed.startsWith('[tool.poetry.dev-dependencies]') ||
          trimmed.startsWith('[project.dependencies]') ||
          trimmed.startsWith('[project.optional-dependencies]')
        ) {
          inDepsSection = true;
          continue;
        }
        if (trimmed.startsWith('[') && inDepsSection) {
          inDepsSection = false;
          continue;
        }
        if (inDepsSection) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const pkgName = trimmed.substring(0, eqIdx).trim().replace(/["']/g, '');
            const lib = matchPythonPackage(pkgName);
            if (lib) libs.add(lib);
          }
        }
      }
    }
  } catch {
    // fall through
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
  } catch {
    // fall through
  }

  return [...libs];
}

const JAVA_ARTIFACT_MAP: Record<string, string> = {
  'spring-boot': 'spring-boot',
  'spring-boot-starter': 'spring-boot',
  'hibernate-core': 'hibernate',
  quarkus: 'quarkus',
  micronaut: 'micronaut',
  'micronaut-inject': 'micronaut',
};

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
  } catch {
    // fall through
  }

  // build.gradle / build.gradle.kts
  try {
    const gradleFiles = ['build.gradle', 'build.gradle.kts'];
    for (const gradleFile of gradleFiles) {
      const gradlePath = path.join(rootDir, gradleFile);
      if (existsSync(gradlePath)) {
        const content = readFileSync(gradlePath, 'utf-8');
        // Gradle Groovy DSL: implementation 'group:artifact:version'
        const groovyMatches = content.matchAll(/implementation\s+['"]([^:'"]+):([^:'"]+)/g);
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
        const kotlinMatches = content.matchAll(/implementation\s*\(\s*['"]([^:'"]+):([^:'"]+)/g);
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
  } catch {
    // fall through
  }

  return [...libs];
}

const RUBY_GEM_MAP: Record<string, string> = {
  rails: 'rails',
  sinatra: 'sinatra',
  rspec: 'rspec',
  'rspec-rails': 'rspec',
};

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
  } catch {
    // fall through
  }

  return [...libs];
}

const DOTNET_PACKAGE_MAP: Record<string, string> = {
  'Microsoft.AspNetCore': 'Microsoft.AspNetCore',
  EntityFramework: 'EntityFramework',
  'Microsoft.EntityFrameworkCore': 'EntityFramework',
};

export function detectDotnetLibraries(rootDir: string): string[] {
  const libs = new Set<string>();

  try {
    const entries = readdirSync(rootDir);
    for (const entry of entries) {
      if (entry.endsWith('.csproj')) {
        const csprojPath = path.join(rootDir, entry);
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
      }
    }
  } catch {
    // fall through
  }

  return [...libs];
}
