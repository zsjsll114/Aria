前言

之前折腾了这个，但是因为没有保存数据丢失了。
重新补回来顺便记录下吧，但我有点懒得记多了，就先写一点吧

主要是想要给自己的Aplayer整理一个自己的歌单服务系统

相关教程
在线音乐播放器-----酷狗音乐api接口抓取
酷狗音乐API接口大全（40+个）
搜索歌名，获取hash值
方法一
http://songsearch.kugou.com/song_search_v2?callback=jQuery191034642999175022426_1489023388639&keyword={歌曲名称}&page=1&pagesize=30&userid=-1&clientver=&platform=WebFilter&tag=em&filter=2&iscorrection=1&privilege_filter=0&_=1489023388641

方法二
http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=歌曲名称&page=1

image

通过hash获取音频
https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=a16edc27165c4ac399b1e2d5facf3aab

一些问题
如果出现报错：

image

需要注意搜索歌曲的pay_type值：通常为0/1/3
其中"0"代表免费歌曲，"3"代表付费歌曲

image

backup_url: 播放地址
image

url：下载地址
image

个人常用的api接口
歌单分类部分
获取精选专区所有分类
http://mobilecdnbj.kugou.com/api/v3/tag/list?pid=0&apiver=2&plat=0

获取热门推荐分类
http://mobilecdnbj.kugou.com/api/v3/tag/recommend?showtype=3&apiver=2&plat=0

获取分类详细信息
http://mobilecdnbj.kugou.com/api/v3/tag/info?&id=68&apiver=2

获取分类歌单信息
http://mobilecdnbj.kugou.com/api/v3/tag/specialList?plat=0&page=1&tagid=12&pagesize=30&ugc=1&id=68&sort=2

歌单
http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1&with_res_tag=1

热门歌单
http://mobilecdnbj.kugou.com/api/v5/special/recommend?recommend_expire=0&sign=52186982747e1404d426fa3f2a1e8ee4&plat=0&uid=0&version=9108&page=1&area_code=1&appid=1005&mid=286974383886022203545511837994020015101&_t=1545746286

新歌部分
华语新歌 1
http://mobilecdnbj.kugou.com/api/v3/rank/newsong?version=9108&plat=0&with_cover=1&pagesize=100&type=1&area_code=1&page=1&with_res_tag=1

欧美新歌 2
http://mobilecdnbj.kugou.com/api/v3/rank/newsong?version=9108&plat=0&with_cover=1&pagesize=100&type=2&area_code=1&page=1&with_res_tag=1

日韩新歌 3
http://mobilecdnbj.kugou.com/api/v3/rank/newsong?version=9108&plat=0&with_cover=1&pagesize=100&type=3&area_code=1&page=1&with_res_tag=1 [/login]

歌曲部分
歌曲下载链接(通过album_id)
http://trackercdnbj.kugou.com/i/v2/?album_audio_id=99121191&behavior=play&cmd=25&album_id=6960309&hash=b5a2d566c9de70422f5e5e7203054219&userid=0&pid=2&version=9108&area_code=1&appid=1005&key=407732fc325852538ca836581fe4e370&pidversion=3001&with_res_tag=1 http://trackercdnbj.kugou.com/i/v2/?album_audio_id=53214003&behavior=play&module=&mtype=0&cmd=26&token=&album_id=1952211&userid=0&hash=34c7777fffdd4fdf04e02af1f6857ca4&pid=2&vipType=65530&version=9108&area_code=1&appid=1005&mid=286974383886022203545511837994020015101&key=0c68167f46e46ed953bd489f6fdc9120&pidversion=3001&with_res_tag=1

排行榜部分
排行榜所有分类
http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1&with_res_tag=1

排行榜期数
http://mobilecdnbj.kugou.com/api/v3/rank/vol?ranktype=2&plat=0&rankid=6666&with_res_tag=1 排行榜 http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=2&plat=0&pagesize=100&area_code=1&page=1&volid=35050&rankid=6666&with_res_tag=1

MV部分
MV信息
http://mobilecdnbj.kugou.com/api/v3/mv/detail?area_code=1&plat=0&mvhash=556bd0885e6e2daaf51abf1229a85c1a&with_res_tag=1

MV分类
http://mobileservice.kugou.com/api/v5/video/recommend_channel?version=9108&plat=0&type=2

MV分类列表
http://mobilecdnbj.kugou.com/api/v5/video/list?version=9108&plat=0&pagesize=20&id=0&page=1&sort=4&short=0

歌手部分的接口
热门歌手
http://mobilecdnbj.kugou.com/api/v5/singer/list?version=9108&showtype=1&plat=0&sextype=0&sort=1&pagesize=100&type=0&page=1&musician=0

飙升歌手
http://mobilecdnbj.kugou.com/api/v5/singer/list?version=9108&showtype=1&plat=0&sextype=0&sort=2&pagesize=100&type=0&page=1&musician=0

歌手信息
http://mobilecdnbj.kugou.com/api/v3/singer/info?singerid=86747&with_res_tag=1 歌手歌曲 http://mobilecdnbj.kugou.com/api/v3/singer/song?sorttype=2&version=9108&identity=3&plat=0&pagesize=100&singerid=86747&area_code=1&page=1&with_res_tag=1

歌手专辑
http://mobilecdnbj.kugou.com/api/v3/singer/album?version=9108&plat=0&pagesize=20&singerid=86747&category=1&area_code=1&page=1&show_album_tag=0

歌手MV
http://mobilecdnbj.kugou.com/api/v3/singer/mv?singername=风小筝&pagesize=20&singerid=86747&page=1&with_res_tag=1

相似歌手
http://kmr.service.kugou.com/v1/author/similar {"clientver":"9108","mid":"286974383886022203545511837994020015101","clienttime":"1545746019","key":"4c8b684568f03eeef985ae271561bcd8","appid":"1005","data":[{"author_id":86747}]}

搜索部分的接口
搜索歌曲
http://msearchcdn.kugou.com/api/v3/search/song?showtype=14&highlight=em&pagesize=30&tag_aggr=1&tagtype=全部&plat=0&sver=5&keyword=你好&correct=1&api_ver=1&version=9108&page=1&area_code=1&tag=1&with_res_tag=1

搜索歌单
http://mobilecdnbj.kugou.com/api/v3/search/special?version=9108&highlight=em&keyword=你好&pagesize=20&filter=0&page=1&sver=2&with_res_tag=1

搜索MV
http://msearch.kugou.com/api/v3/search/mv?version=9108&highlight=em&keyword=你好&pagesize=20&page=1&sver=2&with_res_tag=1

搜索专辑
http://msearch.kugou.com/api/v3/search/album?version=9108&iscorrection=1&highlight=em&plat=0&keyword=你好&pagesize=20&page=1&sver=2&with_res_tag=1

搜索K歌
http://ksongsearch.kugou.com/ksong_search?tag=em&iscorrection=1&keyword=你好&userid=0&pagesize=20&page=1

搜索歌词
http://mobileservice.kugou.com/api/v3/lyric/search?version=9108&highlight=1&keyword=你好&plat=0&pagesize=20&area_code=1&page=1&with_res_tag=1

搜索联想词
http://msearchcdn.kugou.com/new/app/i/search.php?student=0&cmd=302&keyword=你好&with_res_tag=1

热门搜索
http://msearchcdn.kugou.com/api/v3/search/hot?count=20&plat=0&with_res_tag=1

直播推荐列表
http://bjacshow.kugou.com/show7/json/v2/cdn/index/live/list?platform=1&sign=0e2e8fb44383458f&version=9108&pageSize=50&gaodeCode=0371&channel=10&page=1&longitude=113.69&std_plat=5&latitude=34.8

专辑信息
http://mobilecdn.kugou.com/api/v3/album/song?version=9108&albumid=11790366&plat=0&pagesize=100&area_code=1&page=1&with_res_tag=1


---


本版本api是手机版本8352，
1.搜索
搜索歌曲：
http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={关键字}&page={页数}&pagesize={单页数量}
电脑版：
http://songsearch.kugou.com/song_search_v2?keyword=关键字&page=1&pagesize=80&filter=0&bitrate=0&isfuzzy=0&tag=em&inputtype=2&platform=PcFilter&userid=785408929&clientver=8063&iscorrection=3

歌单搜索：
http://mobilecdn.kugou.com/api/v3/search/special?page={页数}&pagesize={单页数量}&keyword={关键字}

专辑搜索：
http://mobilecdn.kugou.com/api/v3/search/album?keyword={关键字}&page={页数}&pagesize={页数}

歌词搜索：
http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword={歌曲名}&duration={歌曲总时长(毫秒)}&hash=歌曲Hash值（可以不用）

2.各种排行榜
新碟上架：
http://service.mobile.kugou.com/v1/yueku/recommend?plat=0&type=8&operator=2&version=8352

获取歌曲所有排行：
http://mobilecdn.kugou.com/api/v3/rank/list?apiver=4&withsong=1&showtype=2&plat=0&parentid=0&version=8352&with_res_tag=1
可获取排行榜ranktype和rankid 然后从下面获取排行榜所有歌曲
http://mobilecdn.kugou.com/api/v3/rank/song?ranktype={type}&rankid={id}&plat=0&page={页数}&pagesize={单页数量}&version=8352&with_res_tag=1

歌单页面：
http://mobilecdn.kugou.com/api/v3/category/special?withsong=1&sort=3&plat=0&ugc=1&page=1&categoryid=0&pagesize=20

3.歌手专辑歌单
获取专辑所有歌曲信息：
http://mobilecdn.kugou.com/api/v3/album/song?albumid={专辑id}&plat=0&page=1&pagesize=-1&version=8352&with_res_tag=1

获取歌单所有歌曲信息：
http://mobilecdn.kugou.com/api/v3/special/song?plat=0&specialid={歌单id}&page=1&pagesize=-1&version=8352&with_res_tag=1

获取歌手所有歌曲：
http://mobilecdn.kugou.com/api/v3/singer/song?plat=0&page=1&sorttype=2&pagesize=20&version=8352&singerid={歌手id}&with_res_tag=1

4.下载和获取播放地址
下载歌词：（参数从搜索歌词中获取）
http://lyrics.kugou.com/download?ver=1&client=pc&id={id}&accesskey={accesskey}&fmt=lrc&charset=utf8

获取歌曲所有格式hash
http://m.kugou.com/app/i/getSongInfo.php?hash={hash}&cmd=playInfo

下载歌曲：（hash从歌曲信息中获取,下载无损同理）
http://trackercdn.kugou.com/i/?cmd=4&hash={hash}&key={MD5({hash}kgcloud)}&pid=1&forceDown=0&vip=1


---


！2024年7月测试，仍有效
！2022年6月测试，仍有效
！2021年9月测试，仍有效
！2020年10月测试，仍有效
百度搜到的都炸了 自己抓了一个

 音乐的就不说了 随便F12抓一下就有了

 歌词的API：

1.搜索歌词

GET http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=F3EA661A19E9A0C965AD64049040BBAC&album_audio_id=

hash必须 其他参数可选 网页端播放音乐的url就有hash

2.获取歌词

GET http://lyrics.kugou.com/download?ver=1&client=pc&id=【上一步得到的id】&accesskey=【上一步得到的accesskey】&fmt=krc&charset=utf8


---


解析酷狗官方KRC歌词接口API

KRC可用API接口kugou已经解决：
搜索歌曲：

http://ioscdn.kugou.com/api/v3/search/song?keyword=关键字&page=1&pagesize=40&showtype=10&plat=2&version=7910&tag=1&correct=1&privilege=1&sver=5
搜索歌词krc：

http://krcs.kugou.com/search?ver=1&man=no&client=pc&keyword=关键字&duration=139039&hash=hash&album_audio_id=album_audio_id&lrctxt=1
 

歌词krc地址：

http://lyrics2.kugou.com/download?accesskey= accesskey &charset=utf8&client=pc&fmt=krc&id=id&ver=1
 

应该是现在好用的KRC接口了！