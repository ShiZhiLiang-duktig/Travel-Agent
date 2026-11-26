/**
 * 个人信息设置弹窗：昵称 / 出发地（省份 → 城市，精确到市级）/ 简介。
 * 出发城市会用于城际交通推荐与 12306 车次查询，所以不能只存省份。
 */
import { useEffect, useState } from "react";
import { Select } from "@douyinfe/semi-ui";
import { saveProfile, type UserProfile } from "../api";
import { PROVINCES, PROVINCE_CITIES, findProvinceByCity } from "../regions";

/** 省份里只有一个城市：直辖市 / 港澳，无需再选第二级 */
const isSingleCityProvince = (province: string) => (PROVINCE_CITIES[province] || []).length === 1;

/** 历史数据里存的是省份（如「山西」），提示用户补选到城市 */
const isLegacyProvinceValue = (v: string) => !!PROVINCE_CITIES[v] && !isSingleCityProvince(v);

export default function ProfileModal({
  open,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: UserProfile | null;
  onClose: () => void;
  onSaved: (p: UserProfile) => void;
}) {
  const [nickname, setNickname] = useState("");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 打开时回填当前资料：把已保存的城市反查回省份；旧的省级值只回填省份
  useEffect(() => {
    if (!open) return;
    const saved = profile?.city || "";
    const savedProvince = findProvinceByCity(saved);
    setNickname(profile?.nickname || "");
    setProvince(savedProvince);
    setCity(isLegacyProvinceValue(saved) ? "" : saved);
    setBio(profile?.bio || "");
    setError("");
  }, [open, profile]);

  if (!open) return null;

  const cities = province ? PROVINCE_CITIES[province] || [] : [];
  const singleCity = province ? isSingleCityProvince(province) : false;
  const legacy = isLegacyProvinceValue(profile?.city || "");

  const submit = async () => {
    const value = city.trim();
    if (province && !value) {
      setError("出发地需要精确到城市，请选择具体城市（如 山西 → 太原）");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await saveProfile({ nickname, city: value, bio });
      onSaved(saved);
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-mask" onClick={onClose}>
      <div className="profile-card glass" onClick={(e) => e.stopPropagation()}>
        <div className="profile-head">
          <div>
            <h3>个人信息</h3>
            <p>出发地精确到城市（直辖市直接选市），用于城际交通与 12306 车次查询</p>
          </div>
          <button type="button" className="profile-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="profile-account">
          <span className="profile-avatar">
            {(profile?.nickname || profile?.username || "U").slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div className="profile-name">{profile?.nickname || profile?.username}</div>
            <div className="profile-meta">
              账号 {profile?.username} · {profile?.role === "admin" ? "管理员" : "普通用户"}
            </div>
            <div className="profile-meta">
              出发城市：{profile?.city || "未设置"}
            </div>
          </div>
        </div>

        <label className="profile-field">
          <span>昵称</span>
          <input
            value={nickname}
            maxLength={30}
            placeholder="怎么称呼你，比如 小途"
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>

        <div className="profile-field">
          <span>出发地（所属省份）</span>
          <Select
            filter
            showClear
            value={province || undefined}
            onChange={(v) => {
              const next = String(v || "");
              setProvince(next);
              // 直辖市 / 港澳只有一个城市，选中即等于选好城市
              setCity(isSingleCityProvince(next) ? PROVINCE_CITIES[next][0] : "");
              setError("");
            }}
            style={{ width: "100%" }}
            placeholder="选择省份 / 直辖市"
            optionList={PROVINCES.map((p) => ({ label: p, value: p }))}
            emptyContent="没有匹配的省份，可输入关键字筛选"
            // 下拉菜单挂载在 body 上，层级必须高于个人信息弹窗的遮罩（1200）
            zIndex={1300}
            dropdownClassName="profile-province-dropdown"
          />
        </div>

        <div className="profile-field">
          <span>出发城市（精确到市级）</span>
          <Select
            filter
            showClear={!singleCity}
            disabled={!province || singleCity}
            value={city || undefined}
            onChange={(v) => {
              setCity(String(v || ""));
              setError("");
            }}
            style={{ width: "100%" }}
            placeholder={
              !province
                ? "请先选择省份"
                : singleCity
                  ? "直辖市 / 特别行政区，无需再选"
                  : `选择${province}的具体城市，如 ${cities[0] || "城市名"}`
            }
            optionList={cities.map((c) => ({ label: c, value: c }))}
            emptyContent="暂无可选城市"
            zIndex={1300}
            dropdownClassName="profile-province-dropdown"
          />
          {legacy && (
            <div className="profile-hint">
              原来保存的是省级「{profile?.city}」，请补选具体城市，12306 才能按城市查车次。
            </div>
          )}
        </div>

        <label className="profile-field">
          <span>个人简介</span>
          <textarea
            value={bio}
            maxLength={200}
            rows={3}
            placeholder="说说你的旅行偏好，比如 喜欢安静的古镇、带老人出行"
            onChange={(e) => setBio(e.target.value)}
          />
        </label>

        {error && <div className="profile-error">{error}</div>}

        <div className="profile-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-run" disabled={saving} onClick={submit}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
