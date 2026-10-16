import requests
import json

def query_telemetry(token, psr_ids, start_time, end_time):
    url = "http://25.64.40.174:18600/realMeasCenter/telemetry/commonQuery"
    headers = {
        'Content-Type': 'application/json',
        'Authorization': token
    }

    body = {
        "filters": [
            {
                "psrIds": psr_ids,
                "psrType": "0403000",
                "telemetryTypes": ["TotW", "TotVar", "A_phsA"],
                "source": "04"
            }
        ],
        "page": 1,
        "perPage": 10,
        "startTime": str(start_time),
        "endTime": str(end_time)
    }

    try:
        response = requests.post(url, headers=headers, json=body)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] 请求失败: {e}")
        return {"error": str(e)}

def process_response(response_text: str):
    data = json.loads(response_text)
    if data.get("status") != "000000" or data.get("errors") != "success":
        return {
            "result": f"接口异常。状态: {data.get('status')}, 错误信息: {data.get('errors')}"
        }

    result = data.get("result", {})
    records = result.get("records", [])
    if not records:
        return {
            "result": "未返回设备数据",
            "summary": {
                "total_measurement_points": 0,
                "all_missing": True,
                "missing_points": []
            }
        }
    missing_points = []
    for device in records:
        telemetry_values = device.get("telemetryValue", [])
        if not telemetry_values or not all(item.get("dataTime") for item in telemetry_values):
            missing_points.append(device.get("measPointId"))
    all_missing = len(missing_points) == len(records)
    summary = {
        "total_measurement_points": len(records),
        "all_missing": all_missing,
        "missing_points": missing_points
    }
    return {
        "result": f"接口正常。摘要: {summary}"
    }

def main(token: str, start_time: str, end_time) -> dict:
    units = [
        {
            "name": "市南",
            "psr_ids": ["20DKX-10030","20DKX-10074","20DKX-10082","20DKX-10140","20DKX-10250","20DKX-10294","20DKX-10329","20DKX-10481","20DKX-10492","20DKX-10591"]
        },
        {
            "name": "江津",
            "psr_ids": ["20DKX-16410","20DKX-22649","20DKX-23969","20DKX-25350","20DKX-2716","20DKX-28331","20DKX-28389","20DKX-28433","20DKX-31309","20DKX-32052"]
        },
		{
            "name": "永川",
            "psr_ids": ["20DKX-14949","20DKX-2339","20DKX-24409","20DKX-270","20DKX-273","20DKX-8329","20DKX-4152","20DKX-84169","20DKX-84189","20DKX-84309"]
        },
		{
            "name": "市区",
            "psr_ids": ["20DKX-85729","20DKX-85949","20DKX-8654","20DKX-8676","20DKX-8720","20DKX-8753","20DKX-8852","20DKX-8874","20DKX-8896","20DKX-8951"]
        },
		{
            "name": "北碚",
            "psr_ids": ["20DKX-11570","20DKX-27410","20DKX-2969","20DKX-3030","20DKX-3192","20DKX-3637","20DKX-3736","20DKX-3747","20DKX-3923","20DKX-3945"]
        },
		{
            "name": "合川",
            "psr_ids": ["0da6f349-61e2-45dc-bcb0-237c0adb034e","188ca67d-0b25-45c7-8b95-63760cffe96a","20DKX-1281","20DKX-13849","20DKX-19289","0a9ef37e-aede-4f72-8aa4-e13cf26bf012","20DKX-4240","20DKX-4284","20DKX-45010","20DKX-5518"]
        },
		{
            "name": "市北",
            "psr_ids": ["20DKX-10052","20DKX-10060","20DKX-10063","20DKX-10192","20DKX-10272","20DKX-10307","20DKX-10371","20DKX-10516","20DKX-10717","20DKX-10769"]
        },
		{
            "name": "璧山",
            "psr_ids": ["20DKX-3151","20DKX-3195","20DKX-3291","20DKX-3318","20DKX-3393","20DKX-3428","20DKX-3470","20DKX-3508","20DKX-40249","20DKX-51989"]
        },
		{
            "name": "綦江",
            "psr_ids": ["143de7dc-54ae-43de-8c86-791682d6b342","20DKX-22270","20DKX-2845","20DKX-2856","20DKX-6704","20DKX-3060","20DKX-7237","20DKX-31889","20DKX-33429","20DKX-3481"]
        },
		{
            "name": "川东",
            "psr_ids": ["20DKX-10151","20DKX-10291","20DKX-1701","20DKX-1759","20DKX-18731","20DKX-22471","20DKX-22509","20DKX-24629","9670ad5b-a2b2-4a7b-bed0-1d95f2b39a59","20DKX-27289"]
        },
		{
            "name": "铜梁",
            "psr_ids": ["20DKX-15189","20DKX-17991","20DKX-21629","20DKX-22790","20DKX-25111","20DKX-28851","20DKX-31009","20DKX-32629","20DKX-38929","20DKX-42009"]
        },
		{
            "name": "长寿",
            "psr_ids": ["20DKX-28169","20DKX-38289","20DKX-6231","20DKX-6250","20DKX-6283","20DKX-6286","20DKX-6330","20DKX-6371","20DKX-63789","20DKX-63869"]
        },
		{
            "name": "万州",
            "psr_ids": ["20DKX-14089","20DKX-163","20DKX-25839","20DKX-3390","20DKX-361","20DKX-3868","20DKX-40329","20DKX-4429","20DKX-4471","20DKX-4968"]
        },
		{
            "name": "开州",
            "psr_ids": ["20DKX-10195","20DKX-11152","20DKX-23829","20DKX-3618","20DKX-9039","20DKX-50729","20DKX-36691","20DKX-3690","20DKX-4273","20DKX-4581"]
        },
		{
            "name": "南川",
            "psr_ids": ["20DKX-182","20DKX-196","20DKX-2529","20DKX-2705","20DKX-765","20DKX-3063","20DKX-3184","20DKX-3208","20DKX-3406","20DKX-3409"]
        },
		{
            "name": "潼南",
            "psr_ids": ["20DKX-4061","20DKX-5172","20DKX-60489","20DKX-6275","20DKX-6550","20DKX-6805","20DKX-68849","20DKX-7364","20DKX-7372","20DKX-7496"]
        },
		{
            "name": "云阳",
            "psr_ids": ["20DKX-10549","20DKX-16069","20DKX-16256","20DKX-16872","20DKX-1748","20DKX-1767","20DKX-17793","20DKX-1825","20DKX-1924","20DKX-1987"]
        },
		{
            "name": "忠县",
            "psr_ids": ["20DKX-10470","20DKX-10813","20DKX-30415","20DKX-30429","20DKX-30869","20DKX-35849","20DKX-5010","20DKX-51109","20DKX-5483","20DKX-5681"]
        },
		{
            "name": "奉节",
            "psr_ids": ["20DKX-15112","20DKX-4683","20DKX-17169","20DKX-19069","20DKX-19369","20DKX-4608","20DKX-5032","20DKX-5065","20DKX-57671","20DKX-57709"]
        },
		{
            "name": "黔江",
            "psr_ids": ["20DKX-12051","20DKX-13990","20DKX-32849","20DKX-35591","20DKX-24289","20DKX-35629","20DKX-36130","20DKX-3703","20DKX-3725","20DKX-37909"]
        },
		{
            "name": "丰都",
            "psr_ids": ["20DKX-30910","20DKX-4482","20DKX-509","20DKX-67529","20DKX-7042","20DKX-90049","46495925-70fe-420b-8e5d-b73a8384da75","6812980c-7f43-426f-a9d0-84b93b2f9295","734023b3-0167-48e7-b0f6-7dac5210fd36","ca1a8859-56ef-46a5-9540-e36a75f2d571"]
        },
		{
            "name": "垫江",
            "psr_ids": ["20DKX-22050","20DKX-2381","20DKX-2526","20DKX-2702","20DKX-32549","20DKX-4262","20DKX-4828","20DKX-4905","20DKX-5582","20DKX-59530"]
        },
		{
            "name": "石柱",
            "psr_ids": ["20DKX-21769","20DKX-32329","20DKX-33729","20DKX-64889","20DKX-7177","20DKX-7592","20DKX-7608","20DKX-7672","20DKX-7782","20DKX-7809"]
        },
		{
            "name": "巫山",
            "psr_ids": ["023583ab-f317-468b-b391-680bf8974356","20DKX-12450","20DKX-12529","20DKX-15211","20DKX-2161","20DKX-2936","20DKX-4319","20DKX-74869","20DKX-75229","20DKX-81213"]
        },
		{
            "name": "大足",
            "psr_ids": ["20DKX-8609","c53863bf-8d73-419d-a0a6-1d127092845c","1c9cde24-bf2a-4bc3-9d11-605de3287990","20DKX-11571","20DKX-19090","20DKX-27389","20DKX-593","20DKX-609","20DKX-61989","20DKX-65509"]
        },
		{
            "name": "酉阳",
            "psr_ids": ["20DKX-7321","20DKX-7387","20DKX-7398","20DKX-7442","20DKX-7662","85c8cb9b-94f3-4b41-b0ac-01052728ed5c","146ceed8-bb6b-41ac-9ead-f2c308e57c23","20DKX-17469","20DKX-59049","20DKX-7598"]
        },
		{
            "name": "秀山",
            "psr_ids": ["20DKX-12271","20DKX-6382","20DKX-6385","20DKX-6409","20DKX-6629","20DKX-6671","20DKX-6690","20DKX-69331","20DKX-82269","20DKX-83889"]
        },
		{
            "name": "巫溪",
            "psr_ids": ["20DKX-10758","20DKX-22949","20DKX-26189","20DKX-28870","20DKX-2947","20DKX-3074","20DKX-43629","20DKX-49352","20DKX-54409","20DKX-59189"]
        },
		{
            "name": "武隆",
            "psr_ids": ["20DKX-10208","20DKX-13154","20DKX-20889","20DKX-27069","20DKX-3283","20DKX-3307","20DKX-4902","20DKX-78450","20DKX-30590","20DKX-3185"]
        },
		{
            "name": "彭水",
            "psr_ids": ["20DKX-13709","20DKX-18310","20DKX-2617","20DKX-2749","20DKX-2801","20DKX-36509","20DKX-7012","20DKX-80289","20DKX-22609","20DKX-2717"]
        },
		{
            "name": "城口",
            "psr_ids": ["20DKX-2603","20DKX-2606","20DKX-34609","20DKX-4836","20DKX-4858","20DKX-1936","20DKX-56709","20DKX-89929","1d069655-b471-41a2-8a6a-05643da5e2ff","20DKX-1608"]
        },
    ]
    all_results = []
    for unit in units:
        psr_ids = unit["psr_ids"]
        response_data = query_telemetry(token, psr_ids, start_time, end_time)

        if "error" in response_data:
            result = {
                "unit_name": unit["name"],
                "result": f"请求失败: {response_data['error']}"
            }
        else:
            response_text = json.dumps(response_data)
            result = {
                "unit_name": unit["name"],
                "result": process_response(response_text)
            }

        all_results.append(result)

    # 构建最终输出结构
    final_output = {
        "units_results": all_results
    }

    # 转换为 JSON 字符串
    final_output_str = json.dumps(final_output, indent=2, ensure_ascii=False)
    return {
        "result": final_output_str,
    }