/* ---------------------------------------------------------------------------
   词库: common Danbooru tags (as NovelAI V5 knows them) with Chinese names,
   for browsing in Tag 模式 and for completing Chinese input offline.
   Loaded on demand — the creation panel imports it only in Tag 模式.
   Each line is `tag|中文名|别名 别名`; tags are in their compared form
   (lowercase, spaces instead of underscores).
   ------------------------------------------------------------------------ */

import { HAS_CJK } from './naiTags';

export interface LibTag { tag: string; zh: string; alias: string[] }

const RAW: [string, string][] = [
  ['人物', `
1girl|一个女孩|女孩 少女 女生 单人女
1boy|一个男孩|男孩 少年 男生
2girls|两个女孩|两女 双人
2boys|两个男孩|两男
3girls|三个女孩|三女
multiple girls|多个女孩|多人 群像
multiple boys|多个男孩
1other|一个非人角色|非人
solo|单人|一个人 独自
solo focus|单人焦点|主角突出
no humans|无人物|没有人 空镜
couple|情侣|一对
siblings|兄弟姐妹
sisters|姐妹
twins|双胞胎
mature female|成熟女性|御姐 熟女
old man|老爷爷|老人 老头
old woman|老奶奶|老婆婆
cat girl|猫娘|猫女
fox girl|狐娘|狐狸女孩
wolf girl|狼娘
dog girl|犬娘|狗娘
rabbit girl|兔娘
dragon girl|龙娘
demon girl|恶魔女孩|魅魔 小恶魔
monster girl|魔物娘
elf|精灵
vampire|吸血鬼
witch|魔女|女巫
angel|天使
fairy|妖精|小精灵
mermaid|美人鱼|人鱼
kitsune|狐妖|九尾狐
oni|鬼|恶鬼
ghost|幽灵|鬼魂
android|仿生人|机器人少女 人造人
robot|机器人
magical girl|魔法少女
knight|骑士
princess|公主
miko|巫女
nun|修女
idol|偶像
ninja|忍者
samurai|武士
pirate|海盗
office lady|职场女性|OL 白领
teacher|老师|教师
doctor|医生
chef|厨师
waitress|女服务员|服务员
soldier|士兵|军人
detective|侦探
`],
  ['发型', `
long hair|长发
very long hair|超长发|及腰长发
absurdly long hair|拖地长发|超级长发
medium hair|中长发|及肩发
short hair|短发
very short hair|极短发|寸头
twintails|双马尾
low twintails|低双马尾
short twintails|短双马尾
ponytail|马尾|单马尾
high ponytail|高马尾
low ponytail|低马尾
side ponytail|侧马尾
braid|辫子|麻花辫
twin braids|双麻花辫|双辫
single braid|单麻花辫|单辫
side braid|侧辫
french braid|法式编发
crown braid|皇冠编发
hair bun|发髻|丸子头 盘发
double bun|双丸子头|包子头
bob cut|波波头
hime cut|姬发式|公主切
pixie cut|精灵短发
blunt bangs|齐刘海|刘海
swept bangs|斜刘海
parted bangs|中分刘海|中分
hair between eyes|眼间刘海|碎刘海
ahoge|呆毛
sidelocks|鬓发|侧发
hair over one eye|遮单眼|遮眼发
messy hair|凌乱头发|乱发
wavy hair|波浪发|大波浪
curly hair|卷发|自然卷
straight hair|直发|黑长直
drill hair|钻头卷|螺旋卷 公主卷
twin drills|双钻头卷
half updo|半扎发
spiked hair|刺猬头|炸毛
hair slicked back|背头
floating hair|飘动的头发|飘发
wet hair|湿发|湿头发
`],
  ['发色', `
white hair|白发|白毛 白色头发
black hair|黑发|黑色头发
blonde hair|金发|黄发 金色头发
platinum blonde hair|铂金发|白金发
brown hair|棕发|茶发 褐发 棕色头发
light brown hair|浅棕发|亚麻色头发
grey hair|灰发|银发 灰色头发 银色头发
pink hair|粉发|粉毛 粉色头发
red hair|红发|红毛 红色头发
blue hair|蓝发|蓝色头发
light blue hair|浅蓝发|天蓝发
dark blue hair|深蓝发
green hair|绿发|绿色头发
light green hair|浅绿发
purple hair|紫发|紫色头发
light purple hair|浅紫发|淡紫发
orange hair|橙发|橘发 橙色头发
aqua hair|青发|水色头发
multicolored hair|多色头发|彩色头发
two-tone hair|双色头发|双色发
split-color hair|阴阳发|左右双色发
gradient hair|渐变发色|渐变发
streaked hair|挑染
colored inner hair|内层挑染|内染
rainbow hair|彩虹发
`],
  ['眼睛', `
blue eyes|蓝眼睛|蓝瞳 碧眼 蓝色眼睛
light blue eyes|浅蓝眼睛|浅蓝瞳
red eyes|红眼睛|红瞳 赤瞳 红色眼睛
green eyes|绿眼睛|绿瞳 绿色眼睛
yellow eyes|黄眼睛|金瞳 金色眼睛 黄瞳
purple eyes|紫眼睛|紫瞳 紫色眼睛
brown eyes|棕眼睛|棕瞳 褐色眼睛
black eyes|黑眼睛|黑瞳
grey eyes|灰眼睛|灰瞳 银瞳
pink eyes|粉眼睛|粉瞳
orange eyes|橙眼睛|橙瞳
aqua eyes|青色眼睛|青瞳
heterochromia|异色瞳|鸳鸯眼 双色瞳
multicolored eyes|多色瞳|彩色眼睛
glowing eyes|发光的眼睛|发光眼
slit pupils|竖瞳|猫瞳 兽瞳
heart-shaped pupils|爱心瞳孔|心形瞳孔
star-shaped pupils|星星瞳孔|星形瞳孔
sparkling eyes|闪亮的眼睛|星星眼
empty eyes|空洞眼神|无神 死鱼眼
closed eyes|闭眼|闭着眼睛
half-closed eyes|半闭眼|眯眼
one eye closed|单眼闭|眨眼 wink
wide-eyed|睁大眼睛|瞪眼
jitome|半眼|鄙视的眼神
tareme|垂眼|下垂眼
tsurime|吊眼|上挑眼
eyelashes|睫毛
long eyelashes|长睫毛
eyeshadow|眼影
eyeliner|眼线
`],
  ['表情', `
smile|微笑|笑 笑容
light smile|浅笑|淡淡的微笑 抿嘴笑
grin|咧嘴笑|露齿笑
laughing|大笑|哈哈大笑
evil smile|邪笑|坏笑 阴笑
smirk|得意的笑|嘴角上扬
:d|张嘴笑|开心笑
:3|猫嘴
:o|O 型嘴|惊讶嘴
open mouth|张嘴|张着嘴
closed mouth|闭嘴|闭着嘴
parted lips|嘴唇微张|微张嘴
blush|脸红|红脸
light blush|微微脸红|淡淡红晕
embarrassed|害羞|难为情 尴尬
crying|哭泣|哭
tears|眼泪|流泪 泪水
sad|悲伤|难过 伤心
angry|生气|愤怒 发怒
annoyed|不耐烦|烦躁
frown|皱眉
pout|嘟嘴|撅嘴
expressionless|面无表情|无表情 冷淡
surprised|惊讶|吃惊
scared|害怕|恐惧
smug|得意|自信 骄傲
serious|严肃|认真
sleepy|困倦|犯困 睡眼惺忪
happy|开心|高兴 快乐
confused|困惑|疑惑
thinking|思考|沉思
nervous|紧张
shouting|大喊|喊叫
tongue out|吐舌头|吐舌
fang|虎牙|小虎牙
>_<|紧闭双眼|囧
`],
  ['服装', `
school uniform|校服|学生服 制服
serafuku|水手服|水手校服
sailor collar|水手领
blazer|西装外套|制服外套
pleated skirt|百褶裙
skirt|裙子|半身裙
miniskirt|超短裙|短裙
long skirt|长裙
dress|连衣裙|裙装
white dress|白色连衣裙|白裙
black dress|黑色连衣裙|黑裙
sundress|夏日连衣裙|吊带裙
maid|女仆装|女仆
apron|围裙
kimono|和服
yukata|浴衣
hanfu|汉服
china dress|旗袍
gothic lolita|哥特萝莉|哥特洛丽塔
lolita fashion|洛丽塔|lo裙
frills|荷叶边|褶边
lace trim|蕾丝边|蕾丝
hoodie|连帽衫|卫衣
hood up|戴兜帽|兜帽
sweater|毛衣|针织衫
turtleneck|高领|高领毛衣
cardigan|开衫|针织开衫
jacket|夹克|外套
coat|大衣
trench coat|风衣
raincoat|雨衣
vest|马甲|背心
shirt|衬衫
white shirt|白衬衫
collared shirt|有领衬衫
t-shirt|T恤|短袖衫
shorts|短裤
jeans|牛仔裤
pants|长裤|裤子
overalls|背带裤
suit|西装|正装
necktie|领带
bowtie|领结
military uniform|军装|军服
nurse|护士服|护士
idol clothes|偶像服|打歌服
track suit|运动服|运动套装
santa costume|圣诞装|圣诞服
wedding dress|婚纱
pajamas|睡衣
swimsuit|泳装|泳衣
armor|盔甲|铠甲
cape|披风
cloak|斗篷
robe|长袍
long sleeves|长袖
short sleeves|短袖
sleeveless|无袖
detached sleeves|分离袖|离袖
wide sleeves|宽袖|广袖
puffy sleeves|泡泡袖
off shoulder|一字肩|露肩
bare shoulders|裸肩|香肩
thighhighs|过膝袜|长筒袜
black thighhighs|黑色过膝袜
white thighhighs|白色过膝袜|白丝
kneehighs|及膝袜|中筒袜
pantyhose|连裤袜|丝袜 裤袜
black pantyhose|黑色连裤袜|黑丝
socks|袜子|短袜
zettai ryouiki|绝对领域
boots|靴子
knee boots|及膝靴|长靴
thigh boots|过膝靴
high heels|高跟鞋
sneakers|运动鞋
loafers|乐福鞋|学生皮鞋
mary janes|玛丽珍鞋|圆头鞋
sandals|凉鞋
barefoot|赤脚|光脚
`],
  ['配饰', `
hat|帽子
witch hat|女巫帽|魔女帽 尖帽子
beret|贝雷帽
baseball cap|棒球帽|鸭舌帽
straw hat|草帽
sun hat|遮阳帽
top hat|礼帽|高顶礼帽
crown|王冠
tiara|头冠|小皇冠
hairband|发箍
hair ribbon|发带|头发丝带
hair bow|发饰蝴蝶结|头上的蝴蝶结
hair ornament|发饰
hairclip|发卡|发夹
hair flower|头花|发花
ribbon|丝带|缎带
bow|蝴蝶结
glasses|眼镜
round eyewear|圆框眼镜
sunglasses|墨镜|太阳镜
eyepatch|眼罩
mask|面具
surgical mask|口罩
headphones|耳机|头戴耳机
earrings|耳环|耳饰
necklace|项链
choker|颈圈|项圈 choker
neck bell|颈铃|铃铛项圈
scarf|围巾
gloves|手套
white gloves|白手套
elbow gloves|长手套|过肘手套
fingerless gloves|露指手套
jewelry|首饰|珠宝
bracelet|手链|手镯
ring|戒指
wristwatch|手表
veil|面纱|头纱
backpack|背包|双肩包
school bag|书包
handbag|手提包|手袋
`],
  ['身体', `
animal ears|兽耳|动物耳朵
cat ears|猫耳|猫耳朵
dog ears|犬耳|狗耳
fox ears|狐耳|狐狸耳朵
rabbit ears|兔耳|兔子耳朵
wolf ears|狼耳
tail|尾巴
cat tail|猫尾|猫尾巴
fox tail|狐尾|狐狸尾巴
multiple tails|多条尾巴|九尾
wings|翅膀
angel wings|天使翅膀|天使之翼
demon wings|恶魔翅膀
feathered wings|羽翼|羽毛翅膀
fairy wings|妖精翅膀|精灵翅膀
dragon wings|龙翼
horns|角|犄角
demon horns|恶魔角
dragon horns|龙角
halo|光环|天使光环
pointy ears|尖耳朵|精灵耳
freckles|雀斑
mole under eye|泪痣
pale skin|白皙皮肤|白皮肤
dark skin|深色皮肤|小麦色皮肤
muscular|肌肉|肌肉发达
scar|伤疤|疤痕
scar on face|脸上的伤疤
tattoo|纹身
facial mark|脸部花纹|面纹
mechanical arms|机械臂
robot joints|机械关节|球形关节
makeup|化妆|妆容
lipstick|口红
nail polish|指甲油|美甲
`],
  ['动作', `
standing|站立|站着
sitting|坐着|坐
seiza|正坐|跪坐
kneeling|跪着|跪
squatting|蹲着|蹲
lying|躺着|躺
on back|仰躺|仰卧
on stomach|趴着|俯卧
on side|侧躺|侧卧
walking|走路|行走 散步
running|奔跑|跑步
jumping|跳跃|跳
flying|飞行|飞
floating|漂浮|悬浮
falling|坠落|下落
dancing|跳舞
singing|唱歌
fighting stance|战斗姿态|战斗姿势
arms up|举起双手|举手
arm up|举起一只手|单手举起
arms behind back|双手背后|手背在身后
arms behind head|双手抱头|手放脑后
hand on hip|单手叉腰|叉腰
hands on hips|双手叉腰
crossed arms|抱臂|双臂交叉 抱胸
crossed legs|翘二郎腿|翘腿 交叉腿
v|比耶|剪刀手 比V
double v|双手比耶
heart hands|比心|手比爱心
thumbs up|点赞|竖大拇指
waving|挥手|招手
salute|敬礼
pointing|指着|指
pointing at viewer|指向镜头
outstretched arm|伸出手臂|伸手
reaching towards viewer|向镜头伸手
head rest|托腮|手托着头
hand on own chest|手放胸口
own hands together|双手合拢|合手
praying|祈祷|合掌
finger to mouth|手指抵唇|嘘
covering mouth|捂嘴
hand in own hair|手插头发|撩头发
wiping tears|擦眼泪
head tilt|歪头
leaning forward|身体前倾|前倾
leaning back|身体后仰|后仰
stretching|伸懒腰
peeking out|探头|偷看
hug|拥抱|抱
hugging own legs|抱膝|抱腿坐
holding hands|牵手
princess carry|公主抱
piggyback|背着|背人
kiss|亲吻|接吻
high five|击掌
holding|拿着|手持
holding umbrella|撑伞|打伞
holding book|拿着书|捧着书
holding sword|持剑|拿剑
holding weapon|拿着武器|持武器
holding cup|拿着杯子|端杯子
holding phone|拿手机
holding flower|拿着花
reading|阅读|看书 读书
eating|吃东西|进食
drinking|喝东西|喝水
sleeping|睡觉|熟睡
cooking|做饭|烹饪
writing|写字
playing instrument|演奏乐器|弹奏
selfie|自拍
looking at viewer|看向镜头|看着观众 直视
looking back|回头看|回眸
looking away|看向别处|移开视线
looking up|抬头看|仰望
looking down|低头看|往下看
looking to the side|看向一侧|侧目
looking at another|看着对方
eye contact|对视|四目相对
facing viewer|面向镜头
facing away|背对镜头
profile|侧脸|侧颜
`],
  ['镜头', `
portrait|肖像|头像
upper body|上半身|半身
cowboy shot|七分身|大腿以上
full body|全身|全身像
lower body|下半身
close-up|特写|近景
eye focus|眼部特写
wide shot|远景|全景 广角
very wide shot|大远景
from above|俯视|俯拍 从上方
from below|仰视|仰拍 从下方
from side|侧面|侧拍
from behind|背面|背影 从后面
straight-on|正面|平视
dutch angle|倾斜构图|斜角镜头
pov|第一人称视角|主观视角 POV
foreshortening|透视缩短|透视
fisheye|鱼眼|鱼眼镜头
depth of field|景深
blurry background|背景虚化|虚化
blurry foreground|前景虚化
bokeh|散景|光斑虚化
silhouette|剪影
symmetry|对称|对称构图
dynamic pose|动态姿势
motion blur|动态模糊
speed lines|速度线
vignetting|暗角
atmospheric perspective|空气透视
feet out of frame|脚部出画
head out of frame|头部出画
`],
  ['时间天气', `
day|白天|日间
night|夜晚|晚上 夜
evening|傍晚
sunset|日落|夕阳 黄昏
sunrise|日出|朝阳
twilight|暮光|薄暮
sky|天空
blue sky|蓝天
cloud|云|云朵
cloudy sky|多云|阴天
night sky|夜空
starry sky|星空|满天星 星星
moon|月亮
full moon|满月
crescent moon|弯月|月牙
sun|太阳
rain|雨|下雨
snow|雪|雪景
snowing|下雪
fog|雾|薄雾 雾气
wind|风|刮风
storm|暴风雨|风暴
lightning|闪电
rainbow|彩虹
aurora|极光
spring (season)|春天|春季
summer|夏天|夏季
autumn|秋天|秋季
winter|冬天|冬季
`],
  ['场景', `
outdoors|户外|室外
indoors|室内
scenery|风景|风景画
nature|大自然|自然
forest|森林|树林
tree|树|树木
grass|草地|草
flower field|花田|花海
cherry blossoms|樱花
falling petals|花瓣飘落|落花
autumn leaves|红叶|枫叶 秋叶
beach|海滩|沙滩 海边
ocean|大海|海 海洋
lake|湖|湖泊
river|河流|河 小溪
waterfall|瀑布
mountain|山|山峰
desert|沙漠
water|水|水面
reflection|倒影|反射
puddle|水坑|积水
underwater|水下|海底
city|城市|都市
cityscape|城市风景|城市全景
city lights|城市灯光|都市夜景
street|街道|街头 马路
alley|小巷|巷子
neon lights|霓虹灯
rooftop|天台|屋顶
building|建筑|楼房
skyscraper|摩天楼|高楼
bridge|桥|桥梁
stairs|楼梯|台阶
balcony|阳台
train station|车站|火车站
train interior|车厢|电车内
bus stop|公交站
village|村庄|乡村
classroom|教室
school|学校
hallway|走廊
library|图书馆
cafe|咖啡馆|咖啡店
restaurant|餐厅|饭店
bedroom|卧室|房间
kitchen|厨房
living room|客厅
window|窗户|窗边
pool|泳池|游泳池
aquarium|水族馆
greenhouse|温室|玻璃花房
shrine|神社
torii|鸟居
temple|寺庙
castle|城堡
church|教堂
ruins|废墟|遗迹
garden|花园|庭院
park|公园
festival|祭典|庙会 节日
fireworks|烟花|焰火
space|太空|宇宙
planet|行星|星球
fantasy|奇幻
science fiction|科幻
cyberpunk|赛博朋克
steampunk|蒸汽朋克
post-apocalypse|末日废土|废土
simple background|简单背景|纯色背景
white background|白色背景|白底
black background|黑色背景|黑底
grey background|灰色背景
gradient background|渐变背景
`],
  ['光影色彩', `
sunlight|阳光|日光
backlighting|逆光|背光
rim lighting|轮廓光|边缘光
light rays|光线|光束 丁达尔
sunbeam|阳光光柱
dappled sunlight|斑驳阳光|树影光斑
moonlight|月光
candlelight|烛光
spotlight|聚光灯
lens flare|镜头光晕|炫光
light particles|光粒子|光点
sparkle|闪光|闪亮 闪闪发光
glowing|发光
bloom|泛光|柔光晕
caustics|焦散|水波光纹
shadow|阴影
dark|暗调|昏暗
colorful|色彩丰富|多彩
pastel colors|粉彩|马卡龙色
muted colors|低饱和|灰调
high contrast|高对比
limited palette|限定色板|少色
monochrome|单色|黑白
greyscale|灰阶|灰度
blue theme|蓝色调|冷色调
red theme|红色调
orange theme|橙色调|暖色调
purple theme|紫色调
green theme|绿色调
pink theme|粉色调
`],
  ['画风', `
anime coloring|动画上色|日系动画
anime screenshot|动画截图|番剧截图
cel shading|赛璐璐|赛璐珞
flat color|平涂
painterly|厚涂|油画感
watercolor (medium)|水彩
oil painting (medium)|油画
colored pencil (medium)|彩铅|彩色铅笔
graphite (medium)|铅笔画|素描
marker (medium)|马克笔
ink wash painting|水墨画|水墨 国风
traditional media|传统媒介|手绘
sketch|草图|速写
lineart|线稿
ukiyo-e|浮世绘
art nouveau|新艺术运动|穆夏风
impressionism|印象派
comic|漫画|漫画风
chibi|Q版|q版 二头身
pixel art|像素画|像素
realistic|写实
photorealistic|照片级写实|真实感
3d|3D|三维
retro artstyle|复古画风|复古
1990s (style)|90 年代画风|90年代
1980s (style)|80 年代画风|80年代
concept art|概念设计|概念图
game cg|游戏 CG|游戏CG
`],
  ['物品动物', `
umbrella|雨伞|伞
transparent umbrella|透明雨伞|透明伞
parasol|阳伞
book|书|书本
sword|剑|刀剑
katana|武士刀|日本刀
gun|枪
bow (weapon)|弓|弓箭
shield|盾牌|盾
staff|法杖
wand|魔杖
flower|花|鲜花
rose|玫瑰
sunflower|向日葵
lily (flower)|百合
bouquet|花束
cup|杯子
teacup|茶杯
food|食物
cake|蛋糕
ice cream|冰淇淋
candy|糖果
fruit|水果
bread|面包
smartphone|手机|智能手机
guitar|吉他
piano|钢琴
violin|小提琴
microphone|麦克风|话筒
camera|相机|照相机
bicycle|自行车|单车
motorcycle|摩托车
car|汽车|车
stuffed toy|毛绒玩具|玩偶
teddy bear|泰迪熊
balloon|气球
lantern|灯笼
paper lantern|纸灯笼
candle|蜡烛
gift|礼物
chair|椅子
bed|床
desk|书桌|桌子
pillow|枕头
mirror|镜子
clock|时钟|钟
cat|猫|猫咪 小猫
black cat|黑猫
dog|狗|小狗
bird|鸟|小鸟
rabbit|兔子
fox|狐狸
wolf|狼
deer|鹿
bear|熊
hamster|仓鼠
penguin|企鹅
owl|猫头鹰
butterfly|蝴蝶
fish|鱼
goldfish|金鱼
jellyfish|水母
whale|鲸鱼|鲸
horse|马
dragon|龙
`],
];

export const TAG_LIBRARY: { name: string; tags: LibTag[] }[] = RAW.map(([name, body]) => ({
  name,
  tags: body.trim().split('\n').map((line) => {
    const [tag, zh, alias = ''] = line.split('|');
    return { tag, zh, alias: alias.split(' ').filter(Boolean) };
  }),
}));

const ALL = TAG_LIBRARY.flatMap((c) => c.tags);
const LABELS = new Map(ALL.map((t) => [t.tag, t.zh]));

/** The tag's Chinese name, when the 词库 has it. */
export const zhLabel = (tag: string) => LABELS.get(tag);

/**
 * Library tags for a query. Chinese matches names and aliases (a longer
 * phrase also finds the words inside it: 白色长发 → long hair); English
 * matches the start of the tag or of one of its words.
 */
export function searchLibrary(query: string, limit = 6): LibTag[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const cjk = HAS_CJK.test(q);
  const hits: [number, LibTag][] = [];
  for (const t of ALL) {
    let best = 9;
    if (cjk) {
      for (const w of [t.zh.toLowerCase(), ...t.alias]) {
        const score = w === q ? 0 : w.startsWith(q) ? 1 : w.includes(q) ? 2
          : w.length >= 2 && q.includes(w) ? 4 - Math.min(w.length, 8) / 10 : 9;
        best = Math.min(best, score);
      }
    } else {
      best = t.tag === q ? 0 : t.tag.startsWith(q) ? 1 : t.tag.split(/[\s()_:-]+/).some((w) => w.startsWith(q)) ? 2 : 9;
    }
    if (best < 9) hits.push([best, t]);
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1].tag.length - b[1].tag.length).slice(0, limit).map((h) => h[1]);
}
