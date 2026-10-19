调整人数、餐费和场地费，即可查看总预算、人均预算与费用构成。金额均为可编辑的假设值。

```ccgui-ui
root = Stack([Heading("团队活动预算计算器", "lg"), Text("修改参数，预算即时更新。所有金额均为假设值。", "muted"), Grid([controls, results], 2)], "normal")
$people = 12
$meal = 120
$venue = 800
food = $people * $meal
total = food + $venue
average = $people > 0 ? @Round(total / $people, 2) : "暂无法计算"
controls = Card([Heading("预算参数", "sm"), NumberInput($people, "参加人数", 0, 10000, 1, "人"), NumberInput($meal, "人均餐费", 0, 100000, 1, "元"), NumberInput($venue, "场地费", 0, 10000000, 1, "元"), Text("餐饮费＝人数×人均餐费；总预算＝餐饮费＋场地费。", "muted")], "subtle")
results = Card([Heading("预算结果", "sm"), Metric("总预算", @Round(total, 2), "元"), Metric("人均预算", average, "元"), Text($people > 0 ? "人均预算包含餐饮及均摊场地费。" : "人数为零时，保留场地费，不计算人均预算。", "muted"), Divider(), BarChart("费用构成", [{label: "餐饮费", value: food}, {label: "场地费", value: $venue}], "元"), Table(["费用项目", "金额（元）"], [["餐饮费", @Round(food, 2)], ["场地费", @Round($venue, 2)]])], "accent")
```

初始按12人、人均餐费120元、场地费800元计算：餐饮费1,440元，总预算 **2,240元**，人均 **186.67元**。仅包含餐饮和场地费用。
