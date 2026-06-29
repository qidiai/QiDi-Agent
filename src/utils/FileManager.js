const fs = require('fs');
const path = require('path');

class FileManager {
  constructor (workspaceDir) {
    this.workspaceDir = workspaceDir || process.env.WORKSPACE_DIR || './workspace';
    this.workspaceDir = path.resolve(this.workspaceDir);
    this._ensureDir(this.workspaceDir);
  }

  _ensureDir (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  resolvePath (relativePath) {
    const fullPath = path.resolve(this.workspaceDir, relativePath);
    const normalized = path.normalize(fullPath);
    if (!normalized.startsWith(this.workspaceDir)) {
      throw new Error('路径超出工作目录范围');
    }
    return normalized;
  }

  readFile (relativePath) {
    const fullPath = this.resolvePath(relativePath);
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    return fs.readFileSync(fullPath, 'utf-8');
  }

  writeFile (relativePath, content) {
    const fullPath = this.resolvePath(relativePath);
    const dir = path.dirname(fullPath);
    this._ensureDir(dir);
    fs.writeFileSync(fullPath, content, 'utf-8');
    return fullPath;
  }

  fileExists (relativePath) {
    const fullPath = this.resolvePath(relativePath);
    return fs.existsSync(fullPath);
  }

  listFiles (relativePath = '.', pattern = null) {
    const fullPath = this.resolvePath(relativePath);
    if (!fs.existsSync(fullPath)) return [];

    const files = [];
    const walk = (dir, base = '') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = base ? `${base}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, relPath);
        } else {
          if (!pattern || pattern.test(relPath)) {
            files.push(relPath);
          }
        }
      }
    };

    walk(fullPath);
    return files;
  }

  getFileTree (relativePath = '.', maxDepth = 3) {
    const fullPath = this.resolvePath(relativePath);
    if (!fs.existsSync(fullPath)) return '';

    const lines = [];
    const walk = (dir, prefix = '', depth = 0) => {
      if (depth > maxDepth) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      entries.forEach((entry, i) => {
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        lines.push(prefix + connector + entry.name + (entry.isDirectory() ? '/' : ''));

        if (entry.isDirectory()) {
          const newPrefix = prefix + (isLast ? '    ' : '│   ');
          walk(path.join(dir, entry.name), newPrefix, depth + 1);
        }
      });
    };

    walk(fullPath);
    return lines.join('\n');
  }
}

module.exports = FileManager;
