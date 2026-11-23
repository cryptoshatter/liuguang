export type ObItem = { id: string; title: string; hint: string; due: string };
export type ObGroup = { title: string; sub: string; items: ObItem[] };

export const JOIN_DATE = "2026-11-23";

export const ONBOARDING: ObGroup[] = [
  {
    title: "入职当天",
    sub: "11/23",
    items: [
      { id: "o1", title: "签署劳动合同", hint: "手机短信链接，或支付宝「E签宝」小程序；签名选手绘", due: "2026-11-23" },
      { id: "o2", title: "签署入职材料", hint: "公众号 › 数字管理 › 人力资源 › 待我处理", due: "2026-11-23" },
      { id: "o3", title: "关注公众号，绑定 EDM 与人力资源", hint: "「信雅达数字化管理平台」", due: "2026-11-23" },
    ],
  },
  {
    title: "第一周",
    sub: "11/27 前",
    items: [
      { id: "o4", title: "修改三个账号的初始密码", hint: "公司邮箱、数字化管理平台、禅道", due: "2026-11-27" },
      { id: "o5", title: "绑定考勤组，开始打卡", hint: "打卡小程序首次登录需自行绑定；上下班都要打", due: "2026-11-27" },
      { id: "o6", title: "激活每刻账号", hint: "激活链接会发到公司邮箱", due: "2026-11-27" },
      { id: "o7", title: "补交缺失的入职材料", hint: "发起「个人信息变更」，只上传缺的那项", due: "2026-11-27" },
    ],
  },
  {
    title: "入职一个月内",
    sub: "12/22 前",
    items: [
      { id: "o8", title: "学习园地：新员工入职资料", hint: "PC 端：PEOPLE 人事管理 › 学习园地", due: "2026-12-22" },
      { id: "o9", title: "新员工培训在线测试", hint: "85 分及以上", due: "2026-12-22" },
      { id: "o10", title: "信息安全培训考试", hint: "85 分及以上", due: "2026-12-22" },
      { id: "o11", title: "确认离职证明、学历证明、体检报告已提交", hint: "学历证明以学信网为准", due: "2026-12-22" },
    ],
  },
  {
    title: "试用期月度考核表",
    sub: "每月结束前 5 日内",
    items: [
      { id: "o12", title: "第 1 月考核表", hint: "12/18 – 12/22", due: "2026-12-22" },
      { id: "o13", title: "第 2 月考核表", hint: "2027/1/18 – 1/22", due: "2027-01-22" },
      { id: "o14", title: "第 3 月考核表", hint: "2/18 – 2/22", due: "2027-02-22" },
      { id: "o15", title: "第 4 月考核表", hint: "3/18 – 3/22", due: "2027-03-22" },
      { id: "o16", title: "第 5 月考核表", hint: "4/18 – 4/22", due: "2027-04-22" },
    ],
  },
  {
    title: "转正",
    sub: "第 6 个月",
    items: [{ id: "o17", title: "发起《员工转正申请表》", hint: "2027/5/18 – 5/22", due: "2027-05-22" }],
  },
];

export const ONBOARDING_ITEMS = ONBOARDING.flatMap((g) => g.items);
