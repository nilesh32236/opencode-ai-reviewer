import { describe, expect, it, vi } from 'vitest';

const { mockExistsSync, mockReadFileSync, mockReaddirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockReaddirSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
}));

import {
  detectDotnetLibraries,
  detectJavaLibraries,
  detectPythonLibraries,
  detectRubyLibraries,
} from '../src/utils/manifest-detector.js';

describe('manifest-detector', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('detectPythonLibraries', () => {
    it('detects frameworks from pyproject.toml [project.dependencies]', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('pyproject.toml'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('pyproject.toml')) {
          return `[project]
name = "myapp"
version = "0.1.0"

[project.dependencies]
fastapi = ">=0.100.0"
sqlalchemy = "^2.0"
pydantic = "^2.0"
pytest = "^8.0"
`;
        }
        return '';
      });

      const result = detectPythonLibraries('/test');

      expect(result).toContain('fastapi');
      expect(result).toContain('sqlalchemy');
      expect(result).toContain('pydantic');
      expect(result).toContain('pytest');
      expect(result).toHaveLength(4);
    });

    it('detects frameworks from pyproject.toml poetry dependencies', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('pyproject.toml'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('pyproject.toml')) {
          return `[tool.poetry.dependencies]
python = "^3.11"
django = "5.0"
flask = "^3.0"
`;
        }
        return '';
      });

      const result = detectPythonLibraries('/test');

      expect(result).toContain('django');
      expect(result).toContain('flask');
      expect(result).toHaveLength(2);
    });

    it('detects frameworks from requirements.txt', () => {
      mockExistsSync.mockImplementation((filePath: string) =>
        filePath.endsWith('requirements.txt'),
      );
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('requirements.txt')) {
          return `fastapi==0.100.0
sqlalchemy>=2.0
pydantic~=2.0
pytest>=8.0
# comment
django>5.0
`;
        }
        return '';
      });

      const result = detectPythonLibraries('/test');

      expect(result).toContain('fastapi');
      expect(result).toContain('sqlalchemy');
      expect(result).toContain('pydantic');
      expect(result).toContain('pytest');
      expect(result).toContain('django');
      expect(result).toHaveLength(5);
    });

    it('returns empty array when no manifest files exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = detectPythonLibraries('/test');

      expect(result).toEqual([]);
    });
  });

  describe('detectJavaLibraries', () => {
    it('detects frameworks from pom.xml', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('pom.xml'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('pom.xml')) {
          return `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.hibernate</groupId>
      <artifactId>hibernate-core</artifactId>
    </dependency>
  </dependencies>
</project>`;
        }
        return '';
      });

      const result = detectJavaLibraries('/test');

      expect(result).toContain('spring-boot');
      expect(result).toContain('hibernate');
    });

    it('detects Quarkus and Micronaut from pom.xml', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('pom.xml'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('pom.xml')) {
          return `<project>
  <dependencies>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-resteasy</artifactId>
    </dependency>
    <dependency>
      <groupId>io.micronaut</groupId>
      <artifactId>micronaut-inject</artifactId>
    </dependency>
  </dependencies>
</project>`;
        }
        return '';
      });

      const result = detectJavaLibraries('/test');

      expect(result).toContain('quarkus');
      expect(result).toContain('micronaut');
    });

    it('detects frameworks from build.gradle', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('build.gradle'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('build.gradle')) {
          return `dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'
  implementation 'org.hibernate:hibernate-core:6.4.0'
  implementation 'io.quarkus:quarkus-core:3.8.0'
}`;
        }
        return '';
      });

      const result = detectJavaLibraries('/test');

      expect(result).toContain('spring-boot');
      expect(result).toContain('hibernate');
      expect(result).toContain('quarkus');
    });

    it('detects frameworks from build.gradle.kts', () => {
      mockExistsSync.mockImplementation((filePath: string) =>
        filePath.endsWith('build.gradle.kts'),
      );
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('build.gradle.kts')) {
          return `dependencies {
  implementation("org.springframework.boot:spring-boot-starter-web:3.2.0")
  implementation("io.micronaut:micronaut-inject:4.0.0")
}`;
        }
        return '';
      });

      const result = detectJavaLibraries('/test');

      expect(result).toContain('spring-boot');
      expect(result).toContain('micronaut');
    });
  });

  describe('detectRubyLibraries', () => {
    it('detects Rails, Sinatra, and RSpec from Gemfile', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('Gemfile'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('Gemfile')) {
          return `source "https://rubygems.org"

gem "rails", "~> 7.1"
gem "sinatra", ">= 3.0"
gem "rspec-rails", "~> 6.0"
`;
        }
        return '';
      });

      const result = detectRubyLibraries('/test');

      expect(result).toContain('rails');
      expect(result).toContain('sinatra');
      expect(result).toContain('rspec');
      expect(result).toHaveLength(3);
    });

    it('returns empty array for unknown gems', () => {
      mockExistsSync.mockImplementation((filePath: string) => filePath.endsWith('Gemfile'));
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('Gemfile')) {
          return `source "https://rubygems.org"

gem "puma", "~> 6.0"
gem "pg", ">= 1.5"
`;
        }
        return '';
      });

      const result = detectRubyLibraries('/test');

      expect(result).toEqual([]);
    });
  });

  describe('detectDotnetLibraries', () => {
    it('detects ASP.NET Core and Entity Framework from .csproj', () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue(['MyApp.csproj']);
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.csproj')) {
          return `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Mvc" Version="8.0.0" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" />
  </ItemGroup>
</Project>`;
        }
        return '';
      });

      const result = detectDotnetLibraries('/test');

      expect(result).toContain('Microsoft.AspNetCore');
      expect(result).toContain('EntityFramework');
    });

    it('returns empty array when no .csproj files exist', () => {
      mockReaddirSync.mockReturnValue(['README.md', 'Program.cs']);

      const result = detectDotnetLibraries('/test');

      expect(result).toEqual([]);
    });
  });
});
