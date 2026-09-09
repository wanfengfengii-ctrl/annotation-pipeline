export const stackFieldInstructions =
  'stack 只列语言、框架、数据库、标准库模块及开发/测试工具名称，可带已核实的版本，用顿号分隔，例如 Python、FastAPI、SQLite、pytest、TypeScript、React、Vite 或 Go 1.23.12、标准库 net/http。不得填业务功能、HTTP 服务与客户端、多进程集成测试、页面完成情况、无第三方依赖等说明，也不填实现建议；版本未核实就省略版本。';
export function formatStack(value) {
  const parts = String(value || '')
    .split(/[,，、;；\r\n]+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        !/^(?:现有|当前|尚未|未接入|无需|无第三方|无外部|仅使用|建议|需要)|^(?:HTTP\s*服务(?:与客户端)?|多进程集成测试|集成测试|无依赖安装).*$/i.test(
          s,
        ),
    )
    .map((s) =>
      s
        .replace(/^(Python(?:\s+\d[\w.]*)?)\s*标准库$/, '$1')
        .replace(/^Python\s+标准库\s+/, '')
        .replace(/[。；;]+$/, ''),
    );
  return [...new Set(parts)].join('、');
}
