<script def>
{
  "widget": { "family": "1x2" }
}
</script>

<script setup>
export default {
  data: {
    title: '小信助手',
    hint: '打开后直接说'
  },

  onCreate() {},
  onAttach() {},
  onDetach() {},
  onDestroy() {}
};
</script>

<widget>
  <view class="widget">
    <text class="kicker">XIAOXIN</text>
    <text class="title">{{title}}</text>
    <text class="hint">{{hint}}</text>
  </view>
</widget>

<style>
.widget {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 8px 12px;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.48);
  border-radius: 6px;
  background-color: #000000;
}

.kicker {
  font-size: 10px;
  line-height: 13px;
  font-family: monospace;
  color: #40ff5e;
}

.title {
  font-size: 14px;
  line-height: 18px;
  color: rgba(64, 255, 94, 0.72);
}

.hint {
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.48);
}
</style>
