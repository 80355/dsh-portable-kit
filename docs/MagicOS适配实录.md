# MagicOS / 国产 ROM 适配实录

这是一份**实测记录**，不是教程。记录的是：为了让一个第三方 App 在荣耀手机上「稳定听到微信通知」，
我们把坑挖到了多深，以及哪些路根本走不通。

测试机：某荣耀旗舰（MagicOS 11 / Android 17，SDK 37）；对照机：另一台荣耀（MagicOS 8 / Android 14）。

---

## 结论先行

1. **MagicOS 会在系统层拦住第三方 App 绑定 `NotificationListenerService`**，用户手动在设置里打开开关也不一定生效。
2. adb 层的所有「豁免」手段（Doze 白名单、后台运行 appops、应用休眠开关）**全部无效**。
3. 唯一可靠的解是：**用户在系统 UI 里手动给 App 加白名单**（自启动 + 关联启动 + 后台活动 + 电池不优化 + 最近任务锁定）。
4. 同理，微信自己被冻结导致的「消息延迟」，也只能靠用户给**微信**加白名单解决。

---

## 证据一：监听服务绑不上（MagicOS 8）

开关在设置里是「已启用」，`enabled_notification_listeners` 里也确实有我们的服务，但：

```text
W ActivityManager: Service starting has been prevented by iaware or trustsbase
    sInfo ServiceInfo{...YourListenerService}
W NotificationListeners: Unable to bind notification listener service:
    ...YourListenerService
```

`dumpsys notification` 的 connected 列表里没有我们的 binder，`dumpsys activity services` 里也没有服务记录。
→ **服务 enabled 但永不 connected**，微信通知来了没人处理，只剩下微信自带的原始通知。

这就是「为什么我的增强通知有时完全不出现」的第一层原因。

---

## 证据二：前台也冻（MagicOS 11）

换到 MagicOS 11 后，拦截方式变了——不是拦绑定，而是**冻结进程**：

```text
{"freeze_pkg":"<你的包名>","freeze_uid":10475,
 "proxy":1,"is_front":1, ...}
```

注意 `is_front: 1`：**前台进程也照样冻**。
同时 iAware 的 FMPS 内存页共享框架在追踪它：

```text
hwpged/iaware fmps_init_record_from_file
  /data/system/iaware/fmps/<你的包名>/... fail errno(2)
```

冻结是全局限的——同一时刻还冻了 GMS、微信输入法、系统设置、天气：

```text
HwActivityManagerServiceEx.killProcessRecordFromMTM
  → Unexpected non-cached process may get frozen soon
```

---

## 证据三：这些 adb 手段全部无效

| 手段 | 命令 | 结果 |
| --- | --- | --- |
| Doze 白名单 | `cmd deviceidle whitelist +<pkg>` | 成功写入，`oom adj` 只从 1001 降到 701，照样冻 |
| 后台运行 | `cmd appops set <pkg> RUN_ANY_IN_BACKGROUND allow` | 成功，无效 |
| 应用休眠 | `cmd app_hibernation get-state <pkg>` | 返回 `false`——说明**这根本不是标准应用休眠**，是厂商私有冻结 |
| 厂商服务 | `cmd IAwareCMSService help` / `IAwareSdkService help` | 都是 `No shell command implementation`，无 shell 面 |

结论：**这些都不是 root 能改的开关**，只能靠用户在 UI 里点。

---

## 用户必须在系统里做的事

### 给 App 本身（让监听能稳定运行）

1. **手机管家 → 应用启动管理 → 找到该 App → 关闭「自动管理」→ 手动管理**，
   三个开关全开：**自启动 / 关联启动 / 后台活动**；
2. **设置 → 电池 → 更多电池设置 → 应用耗电管理 → 该 App → 不优化**；
3. **最近任务**里把该 App **下拉锁定**（防止一键清理顺手杀掉）；
4. 允许通知、允许悬浮通知。

### 给微信（让上游别被冻，否则消息本身延迟）

同上三步，对象换成**微信**。

> 实测：给微信加完白名单后，消息到达恢复实时；不加时微信退后台约 9 秒被冻、再解冻、往复循环，
> 表现为「有时候要手动点开微信才收到消息」。

---

## 另一个独立问题：气泡

Android 的泡泡（bubble）机制要求宿主 Activity 声明 bubble 兼容。
微信没有，于是系统会把微信**全屏**开在泡泡底上，泡泡壳里只剩一个白色 trampoline——表现就是
「气泡点开是个透明框框，不能回复」，且气泡显示完还挂在屏幕上要手动拖走。

这不是我们 App 的 bug，是泡泡机制与宿主 App 的不兼容。
**结论：第三方通知增强不该用气泡**，应该做的是让通知本身点开直达会话。

```kotlin
// 正确做法：contentIntent 用微信自己的会话 PendingIntent
.setContentIntent(conv.contentIntent ?: wechatLaunchIntent(context))
// 不要：.setBubbleMetadata(...)
```

---

## 还有一层：回复按钮为什么做不出来

理想状态是通知里直接带「回复」输入框（像 X / Instagram 那样）。做不到，原因是微信不给：

- `Notification.CarExtender` 在 API 33 已废弃；
- 微信 8.0.79 既不给 `CarExtender`，也不给带 `RemoteInput` 的 `actions`；
- 实测抓到的每一条真实消息都是 `actions=null/empty`、`carExt=null`。

而 X/Ins 能内联回复，是因为**那是它们自己的通知**——它们自己持有回复的 PendingIntent。
第三方监听器只能拿到微信愿意交出来的东西，而微信什么都不交。

---

## 可复用的排查手法

```bash
# 1. 看监听器是否真的连上了（关键）
adb shell dumpsys notification | grep -A3 "Notification listeners"

# 2. 看服务有没有被绑定
adb shell dumpsys activity services <pkg>

# 3. 抓冻结事件（一次抓 20 秒）
adb shell logcat -v time | grep -iE "freeze_pkg|iaware|trustsbase|hibernation"

# 4. 看进程优先级，判断 FGS 有没有真的生效
adb shell dumpsys activity processes | grep -A5 <pkg>

# 5. 把 App 自己的诊断日志捞出来（如果它写了文件）
adb shell run-as <pkg> cat files/diag.log
```

第 4 条尤其有用：如果 `curProcState` 是前台服务态、`oom adj` 在 200 左右，说明 FGS 生效了，
冻结打不动；如果 adj 在 700+ 且 cached=true，那它随时会被清掉。

---

## 给同类项目的建议

1. **别指望 App 内的保活能对抗厂商冻结**。FGS + JobScheduler + 定时 rebind 只能提高存活率，
   打不过系统级的 `freeze_pkg`；
2. **一定要给用户一条明确的、可执行的系统设置指引**，并在 App 里做检测（检测不到就提示）；
3. **监听器断开时不要清空已显示的通知**——那会让用户以为「App 挂了」，比「显示旧通知」更糟；
4. **别用气泡**。用「通知点开直达会话」这种朴素但可靠的方式。