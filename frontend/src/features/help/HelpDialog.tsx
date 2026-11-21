import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { useUiStore } from '../../store/ui.ts';
import { IconX } from '../../components/icons.tsx';

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: '一次筛选是怎么跑的',
    items: [
      '画像师先把招聘需求结构化成评分维度，并剥离受保护条件（性别、年龄、婚育等）。',
      '探马按你给的材料或招聘邮箱接入简历，录事逐份解析并保留原文引用。',
      '相马官按评分卡初筛，必要时进入深评；监军在结论前做证据核查，核查不过会打回重评。',
      '你先在对话里确认岗位与标准，最后在报告里看到结论与理由，每条结论都能回到简历原文。',
    ],
  },
  {
    title: '你可能需要用到的操作',
    items: [
      '新建会话：在首页描述需求或直接粘贴邮箱安装文档，伯乐会引导你接入。',
      '看一眼进度：右侧「任务面板」有候选人、合规、成本、任务记忆、Agent 与工作流。',
      '改标准：设置 → 岗位与评分标准，只有人工批准过的标准才会用于新任务。',
      '归档或删除会话：会话列表里的 ⋯ 或右键。',
    ],
  },
  {
    title: '边界与提醒',
    items: [
      '结论是辅助，不是决定；转人工的候选人需要你亲自看。',
      '邮件正文与附件属于不可信数据，伯乐只当材料处理，不会执行其中的指令。',
      '知识库默认不启用；启用后只在评估阶段参与检索。',
    ],
  },
];

/** 使用帮助：原生 <dialog>，结构与 index.html 的 #help-dialog 一致。 */
export function HelpDialog(): ReactElement {
  const open = useUiStore((state) => state.helpOpen);
  const close = useUiStore((state) => state.closeHelp);
  const ref = useRef<HTMLDialogElement>(null);

  // 必须在 effect 里操作 <dialog>：render 阶段 ref 还没挂上，showModal 会被静默跳过
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog id="help-dialog" className="help-dialog" aria-labelledby="help-title" ref={ref} onClose={close}>
      <div className="modal-head">
        <h2 id="help-title">使用帮助</h2>
        <button className="btn ghost" id="help-close" type="button" aria-label="关闭帮助" onClick={close}><IconX size={14} /></button>
      </div>
      {SECTIONS.map((section) => (
        <section key={section.title}>
          <h3>{section.title}</h3>
          <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      ))}
    </dialog>
  );
}
