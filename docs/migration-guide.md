# 从 arch-doc / dsh-refactor-insight 迁移

两个插件当前各自维护 `arch-profile.mjs`。迁移顺序：

1. 冻结旧输出字段，建立快照测试。
2. 确认旧字段在新 schema 中的映射（见下表）。
3. 引入 `dsh-repo-scanner` 作为 npm dependency，通过库接口或 CLI 调用。
4. 旧命令保留兼容包装一段时间。
5. 两侧输出稳定后删除重复实现。

## 字段映射

| 旧字段 | 新字段 | 备注 |
| --- | --- | --- |
| mainLanguage | project.language | 附 `language_evidence` |
| repoType | project.repo_type | 附 `repo_type_evidence` |
| files[] | files[] | 路径统一 POSIX `/` |
| modules[] | modules[] | 不推断职责，保留 path/file_count/key_files/evidence |
| internalDeps[] | dependencies.internal[] | 仅可解析内部路径 |
| externalDeps[] | dependencies.external[] | 含 manifest 版本 |
| entrypoints/frameworks | entry_points[] | type 使用 web/cli/worker/scheduler/library |
| runCommands[] | run_methods[] | 必须标注 `source` |

## 调用示例

```js
import { scanRepository } from 'dsh-repo-scanner';

const report = await scanRepository({ repoPath, modes: ['probe', 'scan', 'deps'] });
```

CLI 方式：

```bash
node bin/repo-scanner.mjs <repo_path> --probe --scan --deps --json
```

## 兼容包装

旧命令可以先保留，并把结果转换为旧字段形状；不要在旧包装中重新实现扫描逻辑。