export default {
  onLaunch() {
    console.log('Xiaoxin assistant launch');
  },
  onShow() {
    console.log('Xiaoxin assistant show');
  },
  onHide() {
    console.log('Xiaoxin assistant hide');
  },
  globalData: {
    lastQuestion: '',
    lastAnswer: ''
  }
};
