export type Stage = { name: string; weeks: number; why: string; topics: string[] };

export const STAGES: Stage[] = [
  { name: "SQL 基础", weeks: 2, why: "数据开发的第一门基本功，把查询、连接、分组写熟。", topics: ["SELECT / WHERE", "排序与分页", "JOIN", "GROUP BY / HAVING", "常用函数", "子查询", "增删改与建表"] },
  { name: "进阶 SQL", weeks: 2, why: "数据开发每天都在写复杂查询，窗口函数和调优是接下来要补的。", topics: ["窗口函数", "CTE / 子查询改写", "执行计划", "慢查询优化", "银行业务口径练习"] },
  { name: "数仓建模", weeks: 2, why: "理解数据从业务库到报表的分层，是看懂项目表结构的前提。", topics: ["维度建模", "事实表 / 维度表", "ODS / DWD / DWS / ADS", "拉链表"] },
  { name: "Python", weeks: 3, why: "写 ETL 脚本、处理文件和调接口都离不开它。", topics: ["基础语法", "pandas", "文件与数据库读写", "脚本工程化"] },
  { name: "Linux 与 Shell", weeks: 1, why: "任务都跑在服务器上，要能看日志、写调度脚本。", topics: ["常用命令", "权限与进程", "Shell 脚本", "crontab"] },
  { name: "Hadoop / Hive", weeks: 3, why: "大部分离线数仓建在 Hive 上，HQL 是主力语言。", topics: ["HDFS", "Hive 表与分区", "HQL 调优", "数据倾斜"] },
  { name: "Spark", weeks: 3, why: "大数据量计算的主流引擎。", topics: ["RDD / DataFrame", "Spark SQL", "任务调优"] },
  { name: "调度工具", weeks: 1, why: "把每天的任务串起来自动跑。", topics: ["DolphinScheduler / Airflow", "依赖与重跑", "告警"] },
  { name: "实战项目", weeks: 3, why: "用一个完整的小数仓串起前面所有内容。", topics: ["需求到建模", "分层开发", "调度上线", "复盘"] },
];

export const SEED_GOALS = ["SELECT、WHERE、ORDER BY", "多表 JOIN（内连接、左连接）", "GROUP BY 与 HAVING", "完成 10 道基础练习题"];
