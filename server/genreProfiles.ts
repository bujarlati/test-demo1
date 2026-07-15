import type { StoryGenre } from "../src/storyConfig";

export type NarrativeMode = "cultivation" | "wuxia" | "contemporary" | "relationship" | "workplace" | "mystery" | "speculative" | "historical" | "military" | "survival" | "gaming" | "sports";

export interface NarrativeGenreProfile {
  mode: NarrativeMode;
  titles: string[];
  names: string[];
  protagonistPosition: string;
  visibleGoal: string;
  hiddenNeed: string;
  conflictEngine: string;
  recurringCost: string;
  endingShape: string;
  creativeAxes: string[];
}

export interface GenreSceneKit {
  setting: string;
  pressure: string;
  action: string;
  relationship: string;
  consequence: string;
}

export interface GenreCandidateKit {
  disruption: string;
  dilemma: string;
  pressureMove: string;
  sacrifice: string;
  resourceShift: string;
  ruleShift: string;
}

const profiles: Record<StoryGenre, NarrativeGenreProfile> = {
  玄幻: {
    mode: "cultivation",
    titles: ["万象碑", "神骨无名", "诸天烬", "逆命山河"], names: ["沈砚", "陆昭", "宁无尘", "姜照野"],
    protagonistPosition: "被宗门判定血脉枯竭、却能听见远古神骨心跳的外门弟子", visibleGoal: "重铸修为并查明神骨为何选择自己", hiddenNeed: "摆脱以力量证明价值的执念", conflictEngine: "每次突破境界都会唤醒一段被诸宗抹去的上古真相", recurringCost: "借用神骨越深，自身血脉与重要关系越容易被天道抹除", endingShape: "主角重写修炼秩序，却必须放弃成为唯一至强者", creativeAxes: ["血脉觉醒", "宗门博弈", "秘境夺宝", "境界反噬", "诸天因果"],
  },
  仙侠: {
    mode: "cultivation",
    titles: ["山门无月", "问道不归舟", "飞升旧契", "人间有剑"], names: ["谢临渊", "闻照", "裴观澜", "叶停云"],
    protagonistPosition: "灵根残缺却能看见众生因果线的宗门杂役弟子", visibleGoal: "查清宗门飞升者集体失踪的秘密", hiddenNeed: "明白问道不是割舍所有牵挂", conflictEngine: "每解开一段宗门旧史，天道便以新的渡劫规则索取代价", recurringCost: "动用因果之术会损伤灵根，并让一段人间羁绊淡去", endingShape: "主角阻止虚假飞升，以凡身为后来者留下真正的问道路", creativeAxes: ["宗门暗线", "灵根异变", "渡劫代价", "仙凡因果", "飞升骗局"],
  },
  武侠: {
    mode: "wuxia",
    titles: ["旧剑照夜", "江湖第九封信", "无名刀谱", "雪落关山"], names: ["顾长川", "柳惊鸿", "温辞", "霍青崖"],
    protagonistPosition: "替师门押送遗物、却被整个江湖追杀的年轻镖师", visibleGoal: "把遗物送到关外并洗清师门叛名", hiddenNeed: "在门派恩义与个人是非之间建立自己的准则", conflictEngine: "每一门绝学都对应一桩旧债，胜负会改变江湖联盟的立场", recurringCost: "每次借用禁招都会失去一部分惯用武功或一位旧友的信任", endingShape: "真相昭雪但旧门派解散，主角以新规矩重开江湖", creativeAxes: ["门派旧债", "绝学破绽", "镖路伏击", "侠义选择", "朝堂江湖"],
  },
  都市: {
    mode: "contemporary",
    titles: ["长街未眠", "城南合伙人", "人海回声", "下一站烟火"], names: ["周叙", "林见夏", "陈屿", "许知遥"],
    protagonistPosition: "在大城市失去工作后意外接手一间濒临关门的小店的普通人", visibleGoal: "让小店活下来并查清前任经营者突然离开的原因", hiddenNeed: "重新定义成功，而不是活成别人认可的样子", conflictEngine: "每个现实机会都伴随利益、人情与底线之间的选择", recurringCost: "每次向上一步都可能透支健康、亲密关系或最初的理想", endingShape: "主角赢得可持续的生活，也接受成功并非没有遗憾", creativeAxes: ["现实机遇", "商业博弈", "人情冷暖", "家庭牵绊", "城市迁徙"],
  },
  都市异能: {
    mode: "contemporary",
    titles: ["霓虹之外", "异常通勤者", "城市静默区", "能力失效以后"], names: ["程越", "苏弦", "陆清和", "纪遥"],
    protagonistPosition: "白天维持普通工作、夜里负责处理城市异常的低阶能力者", visibleGoal: "阻止能力失控事件扩散并找到自身能力来源", hiddenNeed: "接受脆弱与求助，而不是把普通生活当作伪装", conflictEngine: "超常能力被现代制度量化管理，每次使用都会暴露新的社会裂缝", recurringCost: "能力越强，日常身份记录越不稳定", endingShape: "主角公开异常真相，让能力者与普通人共同制定新秩序", creativeAxes: ["能力进阶", "城市异常", "身份暴露", "组织博弈", "规则副作用"],
  },
  言情: {
    mode: "relationship",
    titles: ["等风说完", "迟来的同路人", "借我一场晴天", "与你重逢之前"], names: ["乔晚", "沈知行", "顾言初", "林予安"],
    protagonistPosition: "结束一段错误关系后重新回到故乡工作的独立策展人", visibleGoal: "完成一场决定职业去留的城市展览", hiddenNeed: "学会表达真实需要，而不是用体面回避亲密", conflictEngine: "事业选择与感情推进相互牵动，每一次靠近都要求双方修正旧有关系模式", recurringCost: "回避沟通会换来短暂安全，却持续损耗信任与机会", endingShape: "两人在各自完整的前提下选择共同生活，而非牺牲一方成全关系", creativeAxes: ["双向成长", "误解澄清", "事业选择", "家庭边界", "重逢心动"],
  },
  校园: {
    mode: "relationship",
    titles: ["晚自习以后", "十七岁的回信", "操场尽头", "夏日排名之外"], names: ["江禾", "宋时雨", "许一川", "唐栀"],
    protagonistPosition: "转学后试图隐藏竞赛退赛原因的高二学生", visibleGoal: "与新同伴完成一项校际挑战并找回学习方向", hiddenNeed: "允许失败被看见，也允许友谊不以优秀为前提", conflictEngine: "考试、社团与家庭期待不断制造成长选择", recurringCost: "每次用成绩掩盖问题，都会错过一次真实沟通", endingShape: "主角不再被单一排名定义，与伙伴奔向各自选择的未来", creativeAxes: ["同桌秘密", "社团挑战", "青春友谊", "家庭期待", "升学选择"],
  },
  职场: {
    mode: "workplace",
    titles: ["十二层灯火", "方案之外", "最后一轮面试", "合伙人席位"], names: ["岑宁", "贺闻", "周砚秋", "程遇"],
    protagonistPosition: "空降到危机项目、同时背负前公司争议的专业经理人", visibleGoal: "在截止日前挽救项目并找到数据造假的责任链", hiddenNeed: "把专业边界置于取悦权威之上", conflictEngine: "资源、信息与组织权力不断重排，每个方案都会触动既得利益", recurringCost: "越接近真相，职位、声誉与团队稳定性越难同时保全", endingShape: "项目完成但旧体系被打破，主角建立更透明的协作方式", creativeAxes: ["项目危机", "办公室政治", "专业判断", "团队信任", "行业真相"],
  },
  悬疑: {
    mode: "mystery",
    titles: ["潮线失真", "无人认领的明天", "雾钟之后", "证词沉入海面"], names: ["程野", "闻溪", "纪临", "沈鸥"],
    protagonistPosition: "知道一桩旧失踪案，却一直否认自己是目击者的通勤者", visibleGoal: "离开不存在的车站并查明车票来源", hiddenNeed: "承认沉默也是旧案的一部分", conflictEngine: "每次追查都会交换一段证人记忆与一条现实证据", recurringCost: "越接近真相，现实中的身份记录越模糊", endingShape: "主角找到失踪者并承担让真相被记住的代价", creativeAxes: ["错误证词", "空间误导", "旧物回声", "时间票据", "身份交换"],
  },
  科幻: {
    mode: "speculative",
    titles: ["第七次日落", "零点之后的回声", "第二颗沉默行星", "明天拒绝重启"], names: ["许澄", "陆弦", "季遥", "程霁"],
    protagonistPosition: "唯一保留时间重置记忆的天文台维修员", visibleGoal: "阻止下一次日落重置并查明黑色行星", hiddenNeed: "接受无法同时拯救每一个版本的人", conflictEngine: "每次技术突破都会保留一种身体代价并抹除一段公共事实", recurringCost: "记忆越完整，身体越无法随世界重置", endingShape: "主角终止循环，选择一个不完美但真实的未来", creativeAxes: ["时间误差", "身体证据", "双重观测", "技术伦理", "身份备份"],
  },
  奇幻: {
    mode: "speculative",
    titles: ["灯塔之外", "影子保管局", "无岸海图", "借来的月光"], names: ["顾遥", "迟萤", "闻舟", "祝岚"],
    protagonistPosition: "拿错影子、因此被古老契约选中的制图学徒", visibleGoal: "归还影子并让熄灭的边境灯塔重新点亮", hiddenNeed: "承认归属来自选择而不是出生安排", conflictEngine: "每种魔法都能实现一个愿望，也会取走一部分自我", recurringCost: "使用力量会忘记一种熟悉的感觉或关系", endingShape: "主角改写契约，让不同族群共同守护世界边界", creativeAxes: ["魔法契约", "地图缺口", "异族同盟", "规则反噬", "身份交换"],
  },
  历史: {
    mode: "historical",
    titles: ["长安无名帖", "山河故档", "驿路春秋", "史官未写"], names: ["裴慎", "谢明夷", "陆昭宁", "崔望"],
    protagonistPosition: "在乱世中负责誊录密档、却发现正史正在被篡改的小吏", visibleGoal: "护送关键档案进京并查清幕后权力链", hiddenNeed: "理解保存真实不仅靠文字，也靠具体的人", conflictEngine: "朝堂决策、地方民生与时代洪流彼此牵动", recurringCost: "每保住一份真相，就可能失去一层官身或一位同路人的安全", endingShape: "档案得以传世，主角却选择留在无名处守护新秩序", creativeAxes: ["朝堂权谋", "地方民生", "史料谜案", "世家博弈", "时代抉择"],
  },
  军事: {
    mode: "military",
    titles: ["烽线以北", "坐标无声", "最后一道防线", "归队之前"], names: ["秦峥", "何远川", "沈岚", "陈拓"],
    protagonistPosition: "临危接手失联小队、却对旧命令存疑的前线指挥员", visibleGoal: "带队完成撤离并查明情报失真的来源", hiddenNeed: "在服从命令与承担判断之间找到责任边界", conflictEngine: "战场信息永远不完整，每个战术选择都改变人员与全局资源", recurringCost: "每次赢得局部优势都要承担补给、时间或袍泽安全的损失", endingShape: "小队完成任务并揭开错误决策链，幸存者重建彼此信任", creativeAxes: ["战术破局", "情报迷雾", "袍泽生死", "后勤极限", "指挥抉择"],
  },
  末世: {
    mode: "survival",
    titles: ["最后一座灯塔", "废土春信", "安全区之外", "明日种子"], names: ["黎川", "顾萤", "周野", "叶槿"],
    protagonistPosition: "带着一份失效地图穿行废土的前生态研究员", visibleGoal: "找到传说中的种子库并建立可持续聚落", hiddenNeed: "从独自求生转向相信共同体能够承担风险", conflictEngine: "资源、生存规则与人群价值观持续冲突，每次迁徙都会改变生态", recurringCost: "使用灾变前技术会消耗不可再生能源并暴露聚落坐标", endingShape: "人们守住种子库，也放弃封闭安全区、开始重建开放家园", creativeAxes: ["资源危机", "灾变真相", "聚落政治", "变异生态", "人性选择"],
  },
  游戏: {
    mode: "gaming",
    titles: ["世界首杀", "服务器尽头", "隐藏职业失效", "重开赛季"], names: ["陆沉", "夏知白", "程星野", "乔羽"],
    protagonistPosition: "因伤退役后以匿名身份回归新游戏的前职业选手", visibleGoal: "带领临时队伍拿下无人通关的世界副本", hiddenNeed: "接受竞技价值不只属于巅峰时期", conflictEngine: "副本机制、公会利益与现实赛制相互影响", recurringCost: "每次使用旧式极限操作都会加重伤势并暴露真实身份", endingShape: "团队赢得世界首杀，主角以新的角色回到赛场", creativeAxes: ["副本机制", "职业成长", "公会博弈", "竞技复盘", "队伍羁绊"],
  },
  体育: {
    mode: "sports",
    titles: ["终场哨响前", "逆风主场", "第十二名队员", "冠军线以外"], names: ["祁越", "江澄", "林北辰", "许南乔"],
    protagonistPosition: "伤愈后被下放替补席、却最了解新战术体系的年轻运动员", visibleGoal: "重新赢得首发并帮助队伍进入最终赛段", hiddenNeed: "把胜负欲变成与团队共同成长的能力", conflictEngine: "训练、阵容与赛场临场变化持续检验个人与团队选择", recurringCost: "每次超负荷表现都会增加旧伤风险并挤压队友机会", endingShape: "队伍争到冠军机会，主角学会在胜利与职业寿命间作成熟选择", creativeAxes: ["训练突破", "赛场逆转", "队内竞争", "伤病管理", "团队战术"],
  },
  无限流: {
    mode: "mystery",
    titles: ["第零号房间", "下一场无人生还", "规则背面", "出口不存在"], names: ["闻彻", "林隙", "简宁", "楚遥"],
    protagonistPosition: "失去进入副本前记忆、却能发现规则漏洞的新玩家", visibleGoal: "带领队友通关并追踪主神空间的真实出口", hiddenNeed: "在反复背叛的环境里重新建立有限信任", conflictEngine: "每个副本都有可验证的生存规则与隐藏的道德陷阱", recurringCost: "利用规则漏洞会永久失去一段现实记忆或安全权限", endingShape: "主角抵达系统核心，让所有参与者获得选择去留的权利", creativeAxes: ["副本规则", "身份猜疑", "限时解谜", "团队淘汰", "主神漏洞"],
  },
  系统流: {
    mode: "speculative",
    titles: ["系统已连接", "任务栏之外", "奖励到账", "权限开启时"], names: ["陈序", "唐未", "陆衡", "苏简"],
    protagonistPosition: "意外绑定成长系统、能够主动选择任务方向的普通青年", visibleGoal: "利用系统能力改变处境，并逐步理解能力能够影响的世界范围", hiddenNeed: "建立由自己选择的长期目标，而不是只追逐眼前数值", conflictEngine: "触发条件、系统反馈、即时奖励与权限解锁持续改变主角行动和世界反应", recurringCost: "能力与影响范围越大，需要处理的目标、关系和秩序选择越复杂，但已获得能力不会被随意收回", endingShape: "主角掌握最高权限，让系统成为实现自我目标的稳定工具", creativeAxes: ["系统任务", "即时奖励", "属性成长", "权限解锁", "世界反馈"],
  },
  宫斗宅斗: {
    mode: "historical",
    titles: ["深院见春", "朱门旧账", "掌家之后", "金簪无主"], names: ["沈令仪", "谢含章", "顾明蘅", "裴知微"],
    protagonistPosition: "家族败落后被迫进入深宅、却掌握一份旧账册的年轻女子", visibleGoal: "保全自身与亲人并查清家产被夺的真相", hiddenNeed: "建立自己的同盟与规则，而不是等待权势庇护", conflictEngine: "礼法、财权与内宅信息差构成层层博弈", recurringCost: "每次借势都会欠下人情、暴露底牌或牺牲一部分名声", endingShape: "主角拿回选择人生的财权与身份，也让旧家法失去控制力", creativeAxes: ["内宅权谋", "账册暗线", "门第婚约", "女性同盟", "家法反制"],
  },
  轻小说: {
    mode: "speculative",
    titles: ["放学后异世界", "社团禁止召唤", "今天也没有存档", "与魔王合租"], names: ["星川遥", "白石凛", "林悠", "夏目澄"],
    protagonistPosition: "只想安稳毕业、却被废弃社团活动室传送到异世界的学生", visibleGoal: "和性格迥异的伙伴找到往返两个世界的方法", hiddenNeed: "主动参与关系与冒险，而不是永远站在旁观位置", conflictEngine: "校园日常与异世界任务交替影响，轻松选择也会留下真实后果", recurringCost: "每次穿越都会让两个世界的时间差扩大并改变伙伴记忆", endingShape: "众人修复通道，以自己的方式保留跨越世界的羁绊", creativeAxes: ["社团日常", "异界冒险", "反差喜剧", "伙伴羁绊", "世界穿越"],
  },
  治愈: {
    mode: "relationship",
    titles: ["风从面包房来", "替清晨留一盏灯", "失物慢慢归来", "今天的香气"], names: ["苏禾", "林葵", "乔安", "夏栀"],
    protagonistPosition: "不愿继承家业却独自守着旧面包房的年轻店主", visibleGoal: "找到每天提前开机的烤箱是谁控制的", hiddenNeed: "允许自己哀悼，而不是只照顾别人的需要", conflictEngine: "每位来客带来一段被压下的记忆与一个无法代替的选择", recurringCost: "帮助一个人就会短暂失去一种重要的气味记忆", endingShape: "奇迹停止后，人们开始直接说出需要，面包房仍然亮着灯", creativeAxes: ["气味记忆", "关系修复", "旧物回声", "日常误会", "角色镜像"],
  },
};

const sceneKits: Record<NarrativeMode, GenreSceneKit> = {
  cultivation: { setting: "晨钟穿过山门，灵气与人群同时在演武场聚拢", pressure: "宗门规矩、境界差距与同辈目光", action: "调动体内力量并验证修炼法门", relationship: "师徒、同门与家族之间未说破的立场", consequence: "经脉、修为和宗门身份上留下的变化" },
  wuxia: { setting: "晨雾沿着驿道散开，客栈外的马蹄声比约定更早", pressure: "门派恩怨、江湖名声与一诺千金", action: "辨认招式、选择出手并守住退路", relationship: "师门旧友与临时同路人的信义", consequence: "伤势、名声与一段江湖关系的改变" },
  contemporary: { setting: "通勤人潮涌进清晨的城市，手机上的未读消息不断增加", pressure: "现实资源、职业身份与家庭期待", action: "调动有限资源完成一次可验证的现实行动", relationship: "同事、家人与新同盟之间的信任", consequence: "工作、生活和社会身份中的真实损失" },
  relationship: { setting: "日常空间刚刚亮起灯，熟悉的人却带来一段迟到的话", pressure: "亲密边界、旧有误解与各自的人生选择", action: "完成一次坦诚沟通，并用行动验证承诺", relationship: "双方与身边重要之人的情感位置", consequence: "信任、距离和未来选择发生的细微变化" },
  workplace: { setting: "办公楼的第一盏灯亮起，截止时间已经出现在所有人的日历上", pressure: "组织权力、专业判断与项目期限", action: "核对事实、调配团队并提交可承担的方案", relationship: "团队成员、上级与利益相关方的立场", consequence: "职位、信誉和项目资源上的明确变化" },
  mystery: { setting: "天色尚暗，现场最普通的细节却与昨日记录出现偏差", pressure: "被遮蔽的真相、互相矛盾的证词与逼近的时限", action: "复核证据、测试推断并设置可追踪的验证", relationship: "证人、调查者与隐瞒者之间脆弱的信任", consequence: "证据链、身份记录和安全边界的改变" },
  speculative: { setting: "观测界面亮起陌生参数，世界规则在熟悉空间里短暂失效", pressure: "未知技术或魔法规则与使用它们的伦理代价", action: "测量异常、尝试能力边界并保留校验记录", relationship: "探索者、规则维护者与异质同伴的立场", consequence: "身体、记忆或现实规则留下的不可逆偏移" },
  historical: { setting: "晨鼓越过城墙，驿使与家臣带来的消息同时抵达", pressure: "礼法、权力、时代局势与普通人的生计", action: "辨认各方筹码并完成一次公开或隐秘的决断", relationship: "家族、盟友与权力中心之间的承诺", consequence: "官身、家产、名望或一方百姓命运的变化" },
  military: { setting: "天光越过阵地，新的坐标与昨夜战报同时送到", pressure: "不完整情报、任务时限与队员安全", action: "校准情报、调整部署并下达可复核的命令", relationship: "指挥者与袍泽在生死压力下的信任", consequence: "补给、阵地、伤情和全局态势的改变" },
  survival: { setting: "废墟外的风带来陌生气味，聚落的储备数字再次下降", pressure: "资源枯竭、环境威胁与共同体规则", action: "勘察路线、分配物资并执行生存方案", relationship: "幸存者、聚落与陌生来客之间的合作", consequence: "资源、栖身地和群体安全上的实际损失" },
  gaming: { setting: "服务器开服提示亮起，副本倒计时与队伍语音同时开始", pressure: "机制限制、竞技排名与队伍配合", action: "读取机制、调整战术并完成一次高风险操作", relationship: "队友、对手与公会之间不断变化的信任", consequence: "角色状态、赛事机会和现实职业生涯的改变" },
  sports: { setting: "训练馆刚开灯，计时器和赛程表已经把压力写得清清楚楚", pressure: "竞技状态、阵容选择、伤病与胜负", action: "完成训练或比赛中的关键技术动作", relationship: "队友、教练与竞争者之间的协作", consequence: "比分、身体状态和队内位置的真实变化" },
};

const candidateKits: Record<NarrativeMode, GenreCandidateKit> = {
  cultivation: { disruption: "一次修炼验证引出了与宗门认知相反的境界反应", dilemma: "守住同门的突破机会与争取自己的稀缺资源", pressureMove: "宗门临时改变试炼规则，并把境界差距变成公开考核", sacrifice: "放弃一件能立刻提升修为的资源，并承受同门质疑", resourceShift: "灵材、功法或秘境资格的归属突然重排", ruleShift: "山门旧规与新出现的修炼法则正面冲突" },
  wuxia: { disruption: "一次交手暴露了旧招式背后未清的门派债务", dilemma: "履行江湖承诺与保护同行者的退路", pressureMove: "对手借门派名声和旧约逼迫众人在公开场合选边", sacrifice: "舍弃取胜最快的一招，并承担名声受损", resourceShift: "兵刃、谱册或通行信物落入意料之外的人手中", ruleShift: "原本中立的驿路与门派地界被新的江湖规矩封锁" },
  contemporary: { disruption: "一次现实行动让机会、成本与人情同时发生变化", dilemma: "保住眼前的工作或生意机会与维护重要关系的边界", pressureMove: "竞争者利用时间、合同和公众评价压缩选择空间", sacrifice: "放弃最快变现的方案，并公开承担一次现实损失", resourceShift: "资金、客源或关键合作关系被重新分配", ruleShift: "熟悉的行业惯例被一项新条件彻底改写" },
  relationship: { disruption: "一次坦诚沟通让被回避的关系分歧真正浮到台面", dilemma: "抓住个人成长机会与兑现对重要之人的承诺", pressureMove: "时间、家庭期待与旧有误解同时挤压双方的选择", sacrifice: "放弃用沉默维持体面，并承受关系暂时疏远", resourceShift: "共同计划、社团资格或日常陪伴的安排发生变化", ruleShift: "原本默认的相处方式不再能支撑下一阶段关系" },
  workplace: { disruption: "一次数据核对让项目成果与组织立场出现正面冲突", dilemma: "按期交付表面成果与保护团队的专业底线", pressureMove: "利益相关方借截止时间和权限调整迫使团队仓促表态", sacrifice: "放弃一次晋升或邀功机会，并公开承担方案责任", resourceShift: "预算、人手或决策权限被转交给新的负责人", ruleShift: "项目流程与新的组织指令开始互相排斥" },
  mystery: { disruption: "一项复核让旧证据产生了与既有推断相反的结果", dilemma: "追踪关键线索与保护可能遇险的证人", pressureMove: "对手利用调查进度设置同时发生的危机", sacrifice: "放弃最直接的答案并承受误解", resourceShift: "证物、记录或证人证言以反常方式重新出现", ruleShift: "熟悉的现场规则因一条可验证的新事实失效" },
  speculative: { disruption: "一次规则测量暴露了能力或技术从未记录的副作用", dilemma: "保留逆转异常的机会与保护同伴的身体或记忆", pressureMove: "未知规则通过权限、时间差或代价机制迫使主角立即选择", sacrifice: "放弃一次高等级能力收益，并承受现实偏移", resourceShift: "权限、能量或关键装置的控制权突然转移", ruleShift: "已知的技术或魔法边界出现可重复的新例外" },
  historical: { disruption: "一项地方决断让朝堂命令与百姓生计正面冲突", dilemma: "保全官身或家族位置与兑现对具体百姓的承诺", pressureMove: "权力中心借礼法、文书和时限迫使各方公开站队", sacrifice: "放弃一层身份庇护，并承担名望或家产损失", resourceShift: "粮道、账册、印信或家产的控制权发生转移", ruleShift: "旧礼法与正在变化的时代局势不再相容" },
  military: { disruption: "一次战术验证显示昨夜情报与前线态势并不一致", dilemma: "完成局部任务与保护队员及全局退路", pressureMove: "敌方利用补给缺口和时间差迫使小队提前行动", sacrifice: "放弃局部战果，并公开承担指挥责任", resourceShift: "补给、阵地或通讯权限被迫重新分配", ruleShift: "既定作战预案因可复核的新情报失效" },
  survival: { disruption: "一次环境勘察让安全路线与聚落资源需求发生冲突", dilemma: "保住有限物资与接纳需要帮助的新成员", pressureMove: "灾变环境与资源短缺同时压缩迁徙窗口", sacrifice: "放弃一批不可再生资源，并承担聚落质疑", resourceShift: "水源、栖身地或运输工具的控制权发生变化", ruleShift: "旧有生存规则因生态变化不再可靠" },
  gaming: { disruption: "一次机制测试让副本攻略与队伍分工同时失效", dilemma: "争取个人排名或首杀机会与保护队伍的通关节奏", pressureMove: "对手公会利用版本机制和赛事时限迫使团队冒险", sacrifice: "放弃一次个人高光或稀有奖励，并暴露战术底牌", resourceShift: "装备、职业位置或副本权限被重新分配", ruleShift: "熟悉的副本机制因版本变化出现新的解法与风险" },
  sports: { disruption: "一次训练测试让既定阵容与真实竞技状态出现冲突", dilemma: "争取首发机会与保护队友及自身的长期竞技状态", pressureMove: "教练组、赛程和对手战术同时压缩调整时间", sacrifice: "放弃一次个人表现机会，并公开伤情或技术短板", resourceShift: "训练时间、战术位置或上场名额被重新分配", ruleShift: "既定阵容与新的比赛节奏不再相容" },
};

export function narrativeProfileForGenre(genre: string): NarrativeGenreProfile {
  return profiles[genre as StoryGenre] ?? profiles.悬疑;
}

export function sceneKitForGenre(genre: string): GenreSceneKit {
  return sceneKits[narrativeProfileForGenre(genre).mode];
}

export function candidateKitForGenre(genre: string): GenreCandidateKit {
  return candidateKits[narrativeProfileForGenre(genre).mode];
}
