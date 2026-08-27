# Examples

- `sample-output.json`：完整 JSON 输出示例，字段遵循 docs/output-schema.md。
- 可用本包自测：`node bin/repo-scanner.mjs . --all --json`。
- 库接口：

```js
import { scanRepository } from 'dsh-repo-scanner';

const report = await scanRepository({ repoPath: '.', modes: ['probe', 'scan'] });
console.log(JSON.stringify(report, null, 2));
```