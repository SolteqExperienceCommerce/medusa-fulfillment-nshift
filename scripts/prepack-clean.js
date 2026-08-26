const fs = require("fs")
const path = require("path")

const root = path.join(process.cwd(), ".medusa", "server")

const removeTestArtifacts = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        fs.rmSync(fullPath, { recursive: true, force: true })
        continue
      }

      removeTestArtifacts(fullPath)
      continue
    }

    if (/\.spec\.(js|ts|d\.ts)$/.test(entry.name)) {
      fs.rmSync(fullPath, { force: true })
    }
  }
}

if (fs.existsSync(root)) {
  removeTestArtifacts(root)
}