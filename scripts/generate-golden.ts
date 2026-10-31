/**
 * 生成 20 份黄金简历（mock 邮箱 .eml）。
 * 固定内容、固定 Message-ID、固定日期，保证演示与回归可复现。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { projectRoot, writeJson } from '../src/util/fsx.ts';

type Format = 'txt' | 'md' | 'html' | 'docx' | 'doc';
type Trap = 'sparse' | 'fabricated' | 'duplicate' | 'malformed' | 'bias';

interface Candidate {
  label: string;
  name: string;
  phone: string;
  email: string;
  format: Format;
  education: string;
  years: number;
  skills: string;
  work: string[];
  projects: string[];
  salary: string;
  note?: string;
  trap?: Trap;
  duplicateOf?: string;
}

const CANDIDATES: Candidate[] = [
  {
    label: 'R01',
    name: '张伟',
    phone: '13800000001',
    email: 'zhangwei01@example.com',
    format: 'docx',
    education: '2015-2019 华东理工大学 计算机科学与技术 本科',
    years: 7,
    skills: 'Java、Spring Boot、MySQL、Redis、Kafka、微服务、分布式',
    work: [
      '2019.07-2022.06 某某科技有限公司 后端工程师\n负责支付系统订单模块开发，使用 Java、Spring Boot、MySQL，主导订单服务拆分，QPS 提升 3 倍。',
      '2022.07-至今 某某金融科技有限公司 后端技术负责人\n带领 6 人团队完成风控中台建设，使用 Kafka、Redis，服务 50 家业务方。',
    ],
    projects: [
      '支付网关重构：主导微服务拆分，接口 P99 从 800ms 降到 180ms。',
      '风控规则引擎：负责规则编排，支撑日均 2 亿次调用。',
    ],
    salary: '40-50K',
    note: 'base 上海，可到岗时间 2 周。',
  },
  {
    label: 'R02',
    name: '李娜',
    phone: '13800000002',
    email: 'lina02@example.com',
    format: 'txt',
    education: '2015-2019 上海交通大学 软件工程 本科',
    years: 5,
    skills: 'Java、Spring Cloud、MySQL、Redis、Elasticsearch、微服务',
    work: [
      '2019.07-2022.06 某某电商科技有限公司 后端工程师\n负责交易系统订单与履约模块，使用 Java、Spring Cloud、MySQL。',
      '2022.07-至今 某某互联网有限公司 交易平台技术负责人\n带领 3 人小组，主导交易系统重构，支撑日订单 100 万。',
    ],
    projects: [
      '交易系统重构：主导服务拆分与分库分表，下单耗时从 200ms 降到 80ms。',
      '商品搜索优化：负责 Elasticsearch 索引与查询改造，查询耗时下降 60%。',
    ],
    salary: '35-45K',
  },
  {
    label: 'R03',
    name: '王强',
    phone: '13800000003',
    email: 'wangqiang03@example.com',
    format: 'md',
    education: '2019-2023 杭州电子科技大学 计算机科学与技术 本科',
    years: 4,
    skills: 'Java、Spring Boot、MySQL、Redis、Docker、微服务',
    work: [
      '2019.07-2023.06 某某支付科技有限公司 后端工程师\n参与清结算系统开发，使用 Java、Spring Boot、MySQL，负责对账批处理优化，处理时效提升 40%。',
    ],
    projects: [
      '清结算批处理：参与对账任务改造，日均处理 5000 万笔流水。',
      '账户服务：负责余额查询接口优化，P99 从 300ms 降到 120ms。',
    ],
    salary: '25-35K',
  },
  {
    label: 'R04',
    name: '刘洋',
    phone: '13800000004',
    email: 'liuyang04@example.com',
    format: 'html',
    education: '2013-2016 复旦大学 软件工程 硕士',
    years: 8,
    skills: 'Java、Spring Boot、Kafka、微服务、分布式',
    work: [
      '2016.07-2020.06 某某银行 软件开发工程师\n负责核心账务系统模块开发，使用 Java、Spring Boot、Oracle。',
      '2020.07-至今 某某银行科技部 技术负责人\n带领 12 人团队完成核心系统迁移，使用 Kafka、Redis，服务 200 家网点。',
    ],
    projects: [
      '核心系统迁移：主导分布式架构改造，迁移 3000 万账户，停机时间缩短 70%。',
      '账务对账平台：负责批处理调度优化，日均处理 800 万笔。',
    ],
    salary: '50-60K',
  },
  {
    label: 'R05',
    name: '陈晨',
    phone: '13800000005',
    email: 'chenchen05@example.com',
    format: 'txt',
    education: '2014-2018 同济大学 计算机科学与技术 本科',
    years: 6,
    skills: 'Java、Spring Boot、MySQL、Redis、微服务、Kafka',
    work: [
      '2018.07-2021.06 某某支付科技有限公司 后端工程师\n负责收单系统订单模块，使用 Java、Spring Boot、MySQL。',
      '2021.07-至今 某某金融科技有限公司 技术负责人\n带领 5 人团队建设收单平台，使用 Kafka、Redis，支撑日均 3000 万笔交易。',
    ],
    projects: [
      '收单平台重构：主导微服务拆分与限流降级，P99 从 600ms 降到 150ms。',
      '商户结算：负责结算批处理优化，日均处理 500 万笔。',
    ],
    salary: '40-50K',
  },
  {
    label: 'R06',
    name: '赵敏',
    phone: '13800000006',
    email: 'zhaomin06@example.com',
    format: 'docx',
    education: '2017-2021 南京大学 计算机科学与技术 本科',
    years: 3,
    skills: 'Java、Spring Boot、MySQL',
    work: [
      '2021.07-2024.06 某某电商有限公司 后端工程师\n参与订单系统开发，使用 Java、Spring Boot、MySQL，负责订单查询接口维护。',
    ],
    projects: ['订单查询优化：参与索引与缓存改造，查询耗时下降 20%。'],
    salary: '20-25K',
  },
  {
    label: 'R07',
    name: '孙浩',
    phone: '13800000007',
    email: 'sunhao07@example.com',
    format: 'html',
    education: '2015-2019 武汉大学 软件工程 本科',
    years: 5,
    skills: 'Java、Spring Cloud、Redis、Kafka、高并发、微服务',
    work: [
      '2019.07-2022.06 某某互联网有限公司 后端工程师\n负责交易链路开发，使用 Java、Spring Cloud、Redis。',
      '2022.07-至今 某某科技有限公司 交易平台负责人\n带领 4 人团队，主导秒杀系统建设，使用 Kafka、Redis，支撑 QPS 5 万。',
    ],
    projects: [
      '秒杀系统：主导库存扣减与限流方案，峰值 QPS 5 万，超卖率 0。',
      '交易链路优化：负责缓存与异步化改造，P99 从 400ms 降到 120ms。',
    ],
    salary: '35-50K',
  },
  {
    label: 'R08',
    name: '周婷',
    phone: '13800000008',
    email: 'zhouting08@example.com',
    format: 'txt',
    education: '2018-2022 上海大学 计算机科学与技术 本科',
    years: 2,
    skills: 'Java、MySQL',
    work: [
      '2022.07-2024.06 某某软件外包公司 开发工程师\n参与银行渠道系统开发，使用 Java、Spring Boot、MySQL，负责表单与接口联调。',
    ],
    projects: ['渠道系统：参与页面与接口开发。'],
    salary: '15-20K',
  },
  {
    label: 'R09',
    name: '吴磊',
    phone: '13800000009',
    email: 'wulei09@example.com',
    format: 'md',
    education: '2011-2015 电子科技大学 通信工程 本科',
    years: 9,
    skills: 'Java、Spring Boot、Oracle、分布式',
    work: [
      '2015.07-2019.06 某某银行 开发工程师\n负责账务系统开发，使用 Java、Spring Boot、Oracle。',
      '2019.07-至今 某某银行 技术负责人\n带领 10 人团队，主导核心系统升级，服务 500 家网点。',
    ],
    projects: ['核心系统升级：主导架构升级，日均处理 300 万笔。'],
    salary: '50-60K',
  },
  {
    label: 'R10',
    name: '郑爽',
    phone: '13800000010',
    email: 'zhengshuang10@example.com',
    format: 'docx',
    education: '2016-2020 苏州大学 计算机科学与技术 本科',
    years: 4,
    skills: 'Python、Go、MySQL、数据平台',
    work: [
      '2020.07-2024.06 某某数据科技有限公司 数据工程师\n负责数据平台开发，使用 Python、Go、MySQL，参与离线数仓建设。',
    ],
    projects: ['离线数仓：参与调度与血缘系统开发。'],
    salary: '25-35K',
  },
  {
    label: 'R11',
    name: '冯涛',
    phone: '13800000011',
    email: 'fengtao11@example.com',
    format: 'txt',
    education: '2013-2016 北京邮电大学 计算机科学与技术 硕士',
    years: 6,
    skills: 'Java、Spring Boot、MySQL、Redis、Kafka、分布式、规则引擎',
    work: [
      '2018.07-2021.06 某某金融科技有限公司 后端工程师\n负责风控规则服务，使用 Java、Spring Boot、Redis。',
      '2021.07-至今 某某金融科技有限公司 风控技术负责人\n带领 3 人团队，主导反欺诈引擎建设，使用 Kafka、Redis、规则引擎，支撑日均 1 亿次调用。',
    ],
    projects: [
      '反欺诈引擎：主导规则编排与灰度回滚，日均 1 亿次调用，误杀率下降 35%。',
      '风控数据服务：负责特征计算优化，P99 从 500ms 降到 90ms。',
    ],
    salary: '45-55K',
  },
  {
    label: 'R12',
    name: '褚琳',
    phone: '13800000012',
    email: 'chulin12@example.com',
    format: 'html',
    education: '2017-2021 华东师范大学 软件工程 本科',
    years: 3,
    skills: 'Java、Spring Boot、MySQL、Redis',
    work: [
      '2021.07-2024.06 某某支付有限公司 后端工程师\n参与对账系统开发，使用 Java、Spring Boot、MySQL，负责对账文件解析。',
    ],
    projects: ['对账系统：参与批处理改造，日均处理 100 万笔。'],
    salary: '20-30K',
  },
  {
    label: 'R13',
    name: '卫东',
    phone: '13800000013',
    email: 'weidong13@example.com',
    format: 'docx',
    education: '2015-2019 西安交通大学 计算机科学与技术 本科',
    years: 5,
    skills: 'Java、Spring Boot、Redis、微服务',
    work: [
      '2019.07-2024.06 某某保险科技有限公司 后端工程师\n负责保单核心系统开发，使用 Java、Spring Boot、Redis，主导保单查询服务重构。',
    ],
    projects: ['保单查询重构：主导缓存与索引改造，P99 从 350ms 降到 110ms。'],
    salary: '30-40K',
  },
  {
    label: 'R14',
    name: '蒋雯',
    phone: '13800000014',
    email: 'jiangwen14@example.com',
    format: 'txt',
    education: '2013-2017 浙江大学 计算机科学与技术 硕士',
    years: 7,
    skills: 'Java、Spring Cloud、MySQL、Kafka、微服务',
    work: [
      '2017.07-2021.06 某某电商有限公司 后端工程师\n负责商品与交易中台开发，使用 Java、Spring Cloud、MySQL。',
      '2021.07-至今 某某电商有限公司 技术负责人\n带领 8 人团队，主导交易中台建设，使用 Kafka、Redis，服务 30 家业务方。',
    ],
    projects: ['交易中台：主导领域拆分与灰度发布，日均订单 200 万，故障恢复时间缩短 60%。'],
    salary: '50-60K',
  },
  {
    label: 'R15',
    name: '沈鹏',
    phone: '13800000015',
    email: 'shenpeng15@example.com',
    format: 'md',
    education: '2016-2020 天津大学 软件工程 本科',
    years: 4,
    skills: 'Java、Spring Boot、MySQL、Redis、高并发',
    work: [
      '2020.07-2024.06 某某证券科技有限公司 后端工程师\n负责行情推送服务，使用 Java、Spring Boot、Redis，主导连接层优化，支撑百万连接。',
    ],
    projects: ['行情推送：主导异步 IO 与批量推送改造，P99 从 150ms 降到 40ms。'],
    salary: '30-40K',
  },
  {
    label: 'R16',
    name: '韩雪',
    phone: '13800000016',
    email: 'hanxue16@example.com',
    format: 'txt',
    education: '2019-2023 上海理工大学 计算机科学与技术 本科',
    years: 3,
    skills: 'Java、Spring Boot、MySQL',
    work: [],
    projects: [],
    salary: '20-25K',
    note: '3 年 Java 后端开发经验，熟悉 Spring Boot、MySQL，其他面议。',
    trap: 'sparse',
  },
  {
    label: 'R17',
    name: '杨帆',
    phone: '13800000017',
    email: 'yangfan17@example.com',
    format: 'docx',
    education: '2015-2019 华东理工大学 计算机科学与技术 本科',
    years: 5,
    skills: 'Java、Spring Boot、MySQL、Redis',
    work: [
      '2019.07-2024.06 某某支付科技有限公司 后端工程师\n负责支付系统订单模块，使用 Java、Spring Boot、MySQL、Redis。',
    ],
    projects: [
      '支付系统订单模块：参与支付系统开发，负责订单查询与退款模块，接口响应优化 30%。',
      '对账服务：参与对账批处理开发，使用 MySQL、Redis。',
    ],
    salary: '25-35K',
    trap: 'fabricated',
  },
  {
    label: 'R18',
    name: '陈晨',
    phone: '13800000005',
    email: 'chenchen05@example.com',
    format: 'txt',
    education: '2014-2018 同济大学 计算机科学与技术 本科',
    years: 6,
    skills: 'Java、Spring Boot、MySQL、Redis、微服务、Kafka',
    work: [
      '2018.07-2021.06 某某支付科技有限公司 后端工程师\n负责收单系统订单模块，使用 Java、Spring Boot、MySQL。',
      '2021.07-至今 某某金融科技有限公司 技术负责人\n带领 5 人团队建设收单平台，使用 Kafka、Redis，支撑日均 3000 万笔交易。',
    ],
    projects: [
      '收单平台重构：主导微服务拆分与限流降级，P99 从 600ms 降到 150ms。',
      '商户结算：负责结算批处理优化，日均处理 500 万笔。',
    ],
    salary: '40-50K',
    trap: 'duplicate',
    duplicateOf: 'R05',
  },
  {
    label: 'R19',
    name: '林峰',
    phone: '13800000019',
    email: 'linfeng19@example.com',
    format: 'doc',
    education: '2016-2020 上海大学 计算机科学与技术 本科',
    years: 4,
    skills: 'Java、Spring Boot',
    work: [],
    projects: [],
    salary: '25-35K',
    trap: 'malformed',
  },
  {
    label: 'R20',
    name: '何静',
    phone: '13800000020',
    email: 'hejing20@example.com',
    format: 'html',
    education: '2016-2020 上海财经大学 金融学 本科',
    years: 4,
    skills: 'Java、Spring Boot、MySQL、Redis',
    work: [
      '2020.07-2024.06 某某支付科技有限公司 后端工程师\n负责交易与对账系统开发，使用 Java、Spring Boot、MySQL、Redis，主导对账任务重构，处理时效提升 50%。',
    ],
    projects: ['对账任务重构：主导批处理拆分，日均处理 800 万笔。'],
    salary: '25-35K',
    note: '已婚未育，34 岁，希望稳定。',
    trap: 'bias',
  },
];

function resumeText(candidate: Candidate): string {
  const lines: string[] = [];
  lines.push(`姓名：${candidate.name}`);
  lines.push(`手机：${candidate.phone}`);
  lines.push(`邮箱：${candidate.email}`);
  lines.push('求职意向：Java 后端工程师');
  lines.push(`教育背景：${candidate.education}`);
  lines.push(`工作年限：${candidate.years} 年`);
  lines.push(`技能标签：${candidate.skills}`);
  if (candidate.work.length > 0) {
    lines.push('工作经历：');
    for (const item of candidate.work) lines.push(item);
  }
  if (candidate.projects.length > 0) {
    lines.push('项目经历：');
    candidate.projects.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  lines.push(`期望薪资：${candidate.salary}`);
  if (candidate.note) lines.push(`备注：${candidate.note}`);
  return `${lines.join('\n')}\n`;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlEscape(text: string): string {
  return xmlEscape(text);
}

// ---------------------------------------------------------------- ZIP (store)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): { time: number; date: number } {
  return { time: ((10 << 11) | (0 << 5) | 0) >>> 0, date: (((2026 - 1980) << 9) | (10 << 5) | 20) >>> 0 };
}

function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const { time, date } = dosDateTime();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, file.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + file.data.length;
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function docxFromText(text: string): Buffer {
  const paragraphs = text
    .split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
    .join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

// ---------------------------------------------------------------- attachments

interface Attachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

function buildAttachment(candidate: Candidate, text: string): Attachment {
  if (candidate.format === 'docx') {
    return {
      filename: `resume-${candidate.label}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: docxFromText(text),
    };
  }
  if (candidate.format === 'doc') {
    // 故意生成无法解析的旧版 Word 二进制（含 OLE 头但内容损坏）
    const garbage = Buffer.alloc(4096);
    garbage.write('D0CF11E0A1B11AE1', 0, 'hex');
    for (let i = 8; i < garbage.length; i += 1) garbage[i] = (i * 37) % 256;
    return { filename: `resume-${candidate.label}.doc`, contentType: 'application/msword', data: garbage };
  }
  if (candidate.format === 'html') {
    const paragraphs = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `<p>${htmlEscape(line)}</p>`)
      .join('\n');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>简历</title></head><body>${paragraphs}</body></html>`;
    return { filename: `resume-${candidate.label}.html`, contentType: 'text/html; charset=utf-8', data: Buffer.from(html, 'utf8') };
  }
  if (candidate.format === 'md') {
    return {
      filename: `resume-${candidate.label}.md`,
      contentType: 'text/markdown; charset=utf-8',
      data: Buffer.from(text, 'utf8'),
    };
  }
  return {
    filename: `resume-${candidate.label}.txt`,
    contentType: 'text/plain; charset=utf-8',
    data: Buffer.from(text, 'utf8'),
  };
}

function base64Lines(buffer: Buffer): string {
  const encoded = buffer.toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function buildEml(candidate: Candidate, attachment: Attachment, index: number): string {
  const boundary = `bole-boundary-${candidate.label}`;
  const date = new Date(Date.UTC(2026, 9, 20, 1, index, 0)).toUTCString();
  const body = `您的简历已收到（${candidate.label}），我们会尽快筛选并与您联系。\r\n`;
  return [
    'From: "BoLe Mock Mailbox" <hr@bole.example>',
    'To: "招聘组" <jobs@bole.example>',
    `Subject: =?UTF-8?B?${Buffer.from(`应聘 Java 后端工程师（${candidate.label}）`).toString('base64')}?=`,
    `Date: ${date}`,
    `Message-ID: <${candidate.label}@bole.mock>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(body, 'utf8')),
    '',
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(attachment.data),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export interface GenerateResult {
  inboxDir: string;
  messages: number;
  files: number;
}

export async function generateGoldenSet(): Promise<GenerateResult> {
  const root = projectRoot();
  const inboxDir = path.join(root, 'data', 'inbox');
  const goldenDir = path.join(root, 'data', 'golden');
  await mkdir(inboxDir, { recursive: true });
  await mkdir(goldenDir, { recursive: true });

  const manifest: Record<string, unknown>[] = [];
  const sourceTexts = new Map<string, string>();

  for (let i = 0; i < CANDIDATES.length; i += 1) {
    const candidate = CANDIDATES[i];
    const text = resumeText(candidate);
    sourceTexts.set(candidate.label, text);
    let attachment: Attachment;
    if (candidate.trap === 'duplicate') {
      const original = CANDIDATES.find((c) => c.label === candidate.duplicateOf)!;
      const originalText = sourceTexts.get(original.label) ?? resumeText(original);
      attachment = buildAttachment(original, originalText);
      attachment.filename = `resume-${candidate.label}.txt`;
    } else {
      attachment = buildAttachment(candidate, text);
    }
    const eml = buildEml(candidate, attachment, i);
    await writeFile(path.join(inboxDir, `${candidate.label}.eml`), eml, 'latin1');
    manifest.push({
      label: candidate.label,
      format: candidate.format,
      trap: candidate.trap ?? null,
      duplicateOf: candidate.duplicateOf ?? null,
      attachment: attachment.filename,
      chars: text.length,
    });
  }

  await writeJson(path.join(goldenDir, 'manifest.json'), {
    generatedTs: '2026-10-20T09:00:00.000Z',
    count: CANDIDATES.length,
    candidates: manifest,
  });

  return { inboxDir, messages: CANDIDATES.length, files: CANDIDATES.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  generateGoldenSet()
    .then((result) => {
      process.stdout.write(`已生成 ${result.messages} 封邮件到 ${result.inboxDir}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
