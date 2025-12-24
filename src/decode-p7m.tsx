import { useEffect, useState } from "react"
import {
  Form,
  ActionPanel,
  Action,
  Detail,
  useNavigation,
  showToast,
  Toast,
  getSelectedFinderItems,
} from "@raycast/api"
import { exec } from "child_process"
import { readFile, writeFile, unlink, copyFile } from "fs/promises"
import { promisify } from "util"
import path from "path"
import os from "os"

const execAsync = promisify(exec)

interface FormValues {
  files: string[]
}

interface DecodedResult {
  originalPath: string
  originalName: string
  decodedName: string
  content: string
  mimeType: string
  savedFilePath?: string
}

function getContentType(filename: string): { mimeType: string; isText: boolean } {
  const ext = path.extname(filename).toLowerCase()
  const textExtensions: Record<string, string> = {
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".json": "application/json",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".eml": "message/rfc822",
  }

  if (textExtensions[ext]) {
    return { mimeType: textExtensions[ext], isText: true }
  }

  const binaryExtensions: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".zip": "application/zip",
  }

  return { mimeType: binaryExtensions[ext] || "application/octet-stream", isText: false }
}

async function decodeP7m(filePath: string): Promise<DecodedResult> {
  const filename = path.basename(filePath)
  const decodedName = filename.replace(/\.p7m$/i, "")
  const tempDir = os.tmpdir()
  const tempInputPath = path.join(tempDir, `p7m-input-${Date.now()}.p7m`)
  const tempOutputPath = path.join(tempDir, `p7m-output-${Date.now()}-${decodedName}`)

  try {
    // Copy input file to temp location
    const inputContent = await readFile(filePath)
    await writeFile(tempInputPath, new Uint8Array(inputContent))

    // Try DER format first (most common for .p7m)
    try {
      await execAsync(`openssl smime -verify -noverify -inform DER -in "${tempInputPath}" -out "${tempOutputPath}"`)
    } catch {
      // Try PEM format as fallback
      try {
        await execAsync(`openssl smime -verify -noverify -inform PEM -in "${tempInputPath}" -out "${tempOutputPath}"`)
      } catch {
        // Try cms command as last resort
        await execAsync(`openssl cms -verify -noverify -inform DER -in "${tempInputPath}" -out "${tempOutputPath}"`)
      }
    }

    // Read the decoded content
    const decodedContent = await readFile(tempOutputPath)
    const { mimeType, isText } = getContentType(decodedName)

    let content: string
    let savedFilePath: string | undefined
    if (isText) {
      content = decodedContent.toString("utf-8")
    } else {
      content = `[Binary file: ${decodedName}]\n\nSize: ${decodedContent.length} bytes\nType: ${mimeType}\n\nFile saved to: ${tempOutputPath}`
      savedFilePath = tempOutputPath
    }

    // Cleanup temp input file (keep output for binary files)
    await unlink(tempInputPath).catch(() => {})
    if (isText) {
      await unlink(tempOutputPath).catch(() => {})
    }

    return {
      originalPath: filePath,
      originalName: filename,
      decodedName,
      content,
      mimeType,
      savedFilePath,
    }
  } catch (error) {
    // Cleanup on error
    await unlink(tempInputPath).catch(() => {})
    await unlink(tempOutputPath).catch(() => {})
    throw error
  }
}

async function saveToDownloads(sourcePath: string, filename: string): Promise<string> {
  const downloadsDir = path.join(os.homedir(), "Downloads")
  const destPath = path.join(downloadsDir, filename)
  await copyFile(sourcePath, destPath)
  return destPath
}

function DecodedView({ result }: { result: DecodedResult }) {
  const { mimeType, isText } = getContentType(result.decodedName)

  let markdown: string

  if (isText) {
    const lang = mimeType === "application/xml" ? "xml" : mimeType === "application/json" ? "json" : ""
    markdown = `# Decoded: ${result.decodedName}

**Original file:** \`${result.originalName}\`
**Type:** ${mimeType}

---

\`\`\`${lang}
${result.content}
\`\`\`
`
  } else {
    markdown = `# Decoded: ${result.decodedName}

**Original file:** \`${result.originalName}\`
**Type:** ${mimeType}

---

${result.content}
`
  }

  return (
    <Detail
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Original File" text={result.originalName} />
          <Detail.Metadata.Label title="Decoded File" text={result.decodedName} />
          <Detail.Metadata.Label title="MIME Type" text={result.mimeType} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {result.savedFilePath && (
            <Action.OpenWith path={result.savedFilePath} title="Open Decoded File" />
          )}
          {result.savedFilePath && (
            <Action
              title="Save to Downloads"
              onAction={async () => {
                try {
                  const destPath = await saveToDownloads(result.savedFilePath!, result.decodedName)
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Saved to Downloads",
                    message: destPath,
                  })
                } catch (error) {
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Failed to save",
                    message: error instanceof Error ? error.message : "Unknown error",
                  })
                }
              }}
            />
          )}
          <Action.CopyToClipboard title="Copy Content" content={result.content} />
          <Action.Open title="Open Original File" target={result.originalPath} />
        </ActionPanel>
      }
    />
  )
}

export default function Command() {
  const { push } = useNavigation()
  const [isLoading, setIsLoading] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])

  useEffect(() => {
    async function loadFinderSelection() {
      try {
        const items = await getSelectedFinderItems()
        const p7mFiles = items.filter((item) => item.path.toLowerCase().endsWith(".p7m")).map((item) => item.path)
        if (p7mFiles.length > 0) {
          setSelectedFiles(p7mFiles)
        }
      } catch {
        // Finder selection not available, that's fine
      }
    }
    loadFinderSelection()
  }, [])

  async function handleSubmit(values: FormValues) {
    const files = values.files
    if (!files || files.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No file selected",
        message: "Please select a .p7m file to decode",
      })
      return
    }

    const filePath = files[0]
    if (!filePath.toLowerCase().endsWith(".p7m")) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid file type",
        message: "Please select a .p7m file",
      })
      return
    }

    setIsLoading(true)

    try {
      const result = await decodeP7m(filePath)
      push(<DecodedView result={result} />)
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to decode",
        message: error instanceof Error ? error.message : "Unknown error occurred",
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Decode P7M" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="files"
        title="P7M File"
        allowMultipleSelection={false}
        canChooseDirectories={false}
        canChooseFiles={true}
        value={selectedFiles}
        onChange={setSelectedFiles}
        info="Select a .p7m file to decode. The file will be decoded using OpenSSL."
      />
      <Form.Description
        title="About"
        text="This extension decodes Italian PEC .p7m signed files (PKCS#7/CMS format) and displays their contents. It requires OpenSSL to be installed on your system."
      />
    </Form>
  )
}
