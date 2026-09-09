const body =
  '为需要联调业务回调的开发者做一个网页工作台，帮助他们定位投递失败和接收结果不一致的问题。用户可以配置接收地址与请求头，编辑事件内容并保存样例，发起投递后在时间轴查看处理状态，展开每次尝试并排核对请求和响应，再对失败事件修改内容、重新发送。\n\n提供内置接收端，允许切换成功、报错和延迟响应，使用本地样例即可独立体验完整流程。重复提交相同事件时返回原记录；同一事件标识对应不同内容时显示冲突，提示另存为新事件。页面以样例列表、内容编辑区和投递时间轴组织操作，保留每次尝试的结果，方便回看和比较。';
const question = (number = 1, title = 'Webhook 投递联调台') =>
  `${number}、${title}\n\n${body}`;
const questionAudit = {
  questionCompliant: true,
  questionChecks: [
    'audience：联调业务回调的开发者定位失败和结果不一致',
    'workflow：从配置接收地址到回看投递结果形成完整联调流程',
    'business：相同事件返回原记录，不同内容提示冲突',
    'web：网页工作台可编辑事件并发起投递',
    'runnable：内置接收端与本地样例支持独立体验',
    'layout：时间轴与请求响应对照区域服务于联调操作',
    'implementation：没有限定架构或数据库',
    'boundary：独立联调功能，未要求改造无关项目',
    'language：编号标题和两段直接需求描述',
  ],
  workflowFeatures: [
    '配置接收地址与请求头',
    '编辑并保存事件样例',
    '发起投递并看时间轴',
    '核对请求与响应',
    '修改失败事件并重新发送',
  ],
  businessDetails: ['相同事件返回原记录', '同标识不同内容提示冲突并另存'],
};
module.exports = { question, body, questionAudit };
