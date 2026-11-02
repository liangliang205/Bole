/**
 * Tools Call 注册表：OpenAI Function Calling 标准（name + description + parameters）
 * + name → (执行函数, schema) 的映射。模型在响应里给出 tool_calls 后，按 name 分发执行。
 *
 * 工具来源：
 * - load_workspace_dependencies：DeepSeek 官方 DSH 工具（@deepseek-ai/dsh-tool-workspace-dependencies），
 *   返回内置 Python / Node / pnpm 的绝对路径与版本；
 * - export_word：开源库 docx（MIT）把终稿报告生成为 Word；
 * - office_export_pdf：DSH 的 Office→PDF 方案，使用官方 @deepseek-ai/libreoffice-kit 转换；
 * - python_exec：在子进程中执行 Python（供需要 python-docx 等自定义流程时使用）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  installPrimaryRuntime,
  readPrimaryRuntime,
  resolvePrimaryRuntime,
  workspaceDependencyPaths,
  type PrimaryRuntimeManifest,
  type WorkspaceDependencies,
} from '@deepseek-ai/dsh-tool-workspace-dependencies';
import { createConverter } from '@deepseek-ai/libreoffice-kit';
import { buildReportDocx } from '../export/docx-report.ts';
import type { ReportData } from '../report/builder.ts';
import type { OpenAiToolSchema } from '../types.ts';
import { MCP_TOOL_PREFIX } from '../mcp/schema.ts';
import type { McpManager } from '../mcp/manager.ts';

export interface ToolContext {
  report: ReportData;
  runDir: string;
  dataDir: string;
  /** 外接 MCP 管理器；未启用时为 undefined，只影响 mcp__ 前缀的工具。 */
  mcp?: McpManager;
}

export interface ToolExecResult {
  ok: boolean;
  message: string;
  files?: string[];
  data?: unknown;
}

export interface ToolDefinition {
  schema: OpenAiToolSchema;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecResult>;
}

const OUTPUT_LIMIT = 8000;

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…（已截断）` : text;
}

function ensureInside(runDir: string, filePath: string): string {
  const resolved = path.resolve(runDir, filePath);
  const base = path.resolve(runDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`路径越界：只允许访问运行目录内的文件（${filePath}）`);
  }
  return resolved;
}

async function findPayloadSource(dataDir: string): Promise<string | null> {
  const candidates = [process.env.BOLE_DSH_PAYLOAD, path.join(dataDir, 'workspace-payload')].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  for (const candidate of candidates) {
    const manifest = path.join(candidate, 'runtime.json');
    if (existsSync(manifest)) return path.resolve(candidate);
  }
  return null;
}

function bundledPython(source: string): Promise<string | null> {
  return readPrimaryRuntime(source)
    .then((manifest: PrimaryRuntimeManifest) => workspaceDependencyPaths(source, manifest).python)
    .catch(() => null);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

const loadWorkspaceDependencies: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'load_workspace_dependencies',
      description:
        'Get absolute paths to bundled Python and library directories, plus bundled Python distribution versions. Node.js and pnpm paths are included when the payload provides them. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use only when a custom Python/Office transformation is needed; routine Word/PDF export does not require this lookup. This does not change PATH or package-manager settings.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  run: async (_args, ctx) => {
    const source = await findPayloadSource(ctx.dataDir);
    if (!source) {
      return {
        ok: false,
        message:
          '未找到 DSH workspace payload（需要包含 runtime.json 与 dependencies/ 的目录）。可设置 BOLE_DSH_PAYLOAD 指向 payload 目录；默认导出流程不需要该工具（export_word 使用内置 docx 库）。',
      };
    }
    const root = process.env.BOLE_DSH_PRIMARY_ROOT;
    const paths: WorkspaceDependencies = root ? await installPrimaryRuntime(source, root) : await resolvePrimaryRuntime(source);
    return {
      ok: true,
      message: '内置运行时依赖路径已返回。',
      data: {
        python: paths.python,
        node: paths.node ?? null,
        pnpm: paths.pnpm ?? null,
        pythonPackages: paths.pythonPackages,
        nodePackages: paths.nodePackages ?? null,
        pythonDistributions: paths.pythonDistributions,
      },
    };
  },
};

const exportWord: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'export_word',
      description:
        'Generate the final recruiting report as an editable Word document in the run directory. Use only when HR explicitly requests a Word/editable report; do not generate a file proactively. Reads the existing report.json without modifying it and returns the .docx path.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  run: async (_args, ctx) => {
    const buffer = await buildReportDocx(ctx.report);
    if (buffer.length < 2 || buffer.subarray(0, 2).toString('ascii') !== 'PK') {
      throw new Error('Word 生成失败：输出不是有效的 DOCX 文件');
    }
    const target = path.join(ctx.runDir, 'report.docx');
    await writeFile(target, buffer);
    return { ok: true, message: `已生成 Word：${target}`, files: [target], data: { bytes: buffer.length } };
  },
};

const officeExportPdf: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'office_export_pdf',
      description:
        'Convert the final saved Word report to a new PDF with LibreOffice Kit. Use only after HR explicitly requests PDF; the .docx source must exist and is preserved. Validates the command result, nonempty output, and %PDF- signature. Returns the .pdf path.',
      parameters: {
        type: 'object',
        properties: {
          docxPath: { type: 'string', description: '要转换的 .docx 路径（运行目录内）；缺省为 report.docx' },
        },
        additionalProperties: false,
      },
    },
  },
  run: async (args, ctx) => {
    const docxPath = ensureInside(ctx.runDir, String(args.docxPath ?? 'report.docx'));
    if (!/\.docx$/i.test(docxPath)) throw new Error('office_export_pdf 只接受 .docx 文件');
    if (!existsSync(docxPath)) throw new Error(`找不到 docx 文件：${docxPath}，请先调用 export_word`);
    const outputPath = docxPath.replace(/\.docx$/i, '.pdf');
    const converter = await createConverter({ timeoutMs: 120_000 });
    try {
      const result = await converter.render({ inputPath: docxPath, outputPath });
      const output = await readFile(outputPath).catch(() => null);
      if (!output?.length || output.subarray(0, 5).toString('ascii') !== '%PDF-') {
        await rm(outputPath, { force: true });
        throw new Error('PDF 生成失败：输出为空或缺少 %PDF- 文件签名');
      }
      return {
        ok: true,
        message: `已生成 PDF：${outputPath}${result.pageCount ? `（${result.pageCount} 页）` : ''}`,
        files: [outputPath],
        data: { backend: result.backend, pageCount: result.pageCount, missingFonts: result.missingFonts, bytes: output.length },
      };
    } finally {
      await converter.dispose();
    }
  },
};

const pythonExec: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'python_exec',
      description:
        'Execute Python in the run directory for a custom document or data transformation that HR explicitly requested. Do not use it to inspect report.json or to produce routine Word/PDF exports; use export_word or office_export_pdf for those. Returns stdout/stderr with a 30s default timeout.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 Python 代码' },
          timeoutMs: { type: 'number', description: '超时毫秒数（默认 30000，最大 120000）' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
  },
  run: async (args, ctx) => {
    const code = String(args.code ?? '');
    if (!code.trim()) throw new Error('code 不能为空');
    const timeoutMs = Math.min(120_000, Math.max(1_000, Number(args.timeoutMs ?? 30_000)));
    const source = await findPayloadSource(ctx.dataDir);
    const interpreter = (source ? await bundledPython(source) : null) ?? (process.platform === 'win32' ? 'python' : 'python3');
    const scriptDir = path.join(ctx.runDir, 'artifacts', 'python');
    await mkdir(scriptDir, { recursive: true });
    const script = path.join(scriptDir, `script_${Date.now()}.py`);
    await writeFile(script, code, 'utf8');
    try {
      const result = await runCommand(interpreter, [script], ctx.runDir, timeoutMs);
      const ok = !result.timedOut && result.code === 0;
      return {
        ok,
        message: result.timedOut
          ? `Python 执行超时（${timeoutMs}ms）`
          : `Python 退出码 ${result.code ?? 'null'}${ok ? '' : '（执行失败）'}`,
        data: { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exitCode: result.code },
      };
    } finally {
      await rm(script, { force: true });
    }
  },
};

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  load_workspace_dependencies: loadWorkspaceDependencies,
  export_word: exportWord,
  office_export_pdf: officeExportPdf,
  python_exec: pythonExec,
};

export function toolSchemas(): OpenAiToolSchema[] {
  return Object.values(TOOL_REGISTRY).map((tool) => tool.schema);
}

/**
 * 内置工具 + 外接 MCP 工具：白名单来自 agents.json 的 mcp 字段，
 * 未配置或服务没连上时自动退化为只有内置工具。
 */
export function toolSchemasWithMcp(mcp: McpManager | undefined, patterns: string[] | undefined): OpenAiToolSchema[] {
  const base = toolSchemas();
  if (!mcp || !patterns || patterns.length === 0) return base;
  const external = mcp.toolsFor(patterns);
  return external.length ? [...base, ...external] : base;
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolExecResult> {
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    if (!ctx.mcp) {
      return { ok: false, message: `未启用外接 MCP，无法调用 ${name}（在 config/mcp.json 配置服务后重试）` };
    }
    return await ctx.mcp.callTool(name, rawArgs);
  }
  const tool = TOOL_REGISTRY[name];
  if (!tool) return { ok: false, message: `未知工具：${name}（可用：${Object.keys(TOOL_REGISTRY).join(', ')}）` };
  let args: Record<string, unknown> = {};
  if (rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, message: `工具参数不是合法 JSON：${rawArgs.slice(0, 200)}` };
    }
  }
  try {
    return await tool.run(args, ctx);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
