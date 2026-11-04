import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
ColumnLayout {
 id:game
 property real unit:Math.min(44,(width-16)/9)
 Layout.fillWidth:true;spacing:12
 RowLayout{Layout.fillWidth:true
  Text{textFormat:Text.PlainText;text:"中国象棋";font.pixelSize:20;color:"#dfedf2"}
  Item{Layout.fillWidth:true}
  ComboBox{model:["本地练习","角色对手"];onActivated:session.gameModeChanged(currentIndex===1)}
 }
 Text{textFormat:Text.PlainText;text:session.gameStatus;color:"#a8cbbb";font.pixelSize:12;wrapMode:Text.Wrap;Layout.fillWidth:true}
 Item{id:board;Layout.preferredWidth:unit*9;Layout.preferredHeight:unit*10;Layout.alignment:Qt.AlignHCenter
  Rectangle{anchors.fill:parent;color:"#b4b9a7";radius:13;border.color:"#dae1c8"}
  Canvas{anchors.fill:parent;onWidthChanged:requestPaint();onPaint:{const c=getContext("2d");c.clearRect(0,0,width,height);c.strokeStyle="#536567";c.lineWidth=1;for(let r=0;r<10;r++){c.beginPath();c.moveTo(game.unit/2,game.unit*(r+.5));c.lineTo(game.unit*8.5,game.unit*(r+.5));c.stroke()}for(let f=0;f<9;f++){c.beginPath();c.moveTo(game.unit*(f+.5),game.unit/2);c.lineTo(game.unit*(f+.5),game.unit*4.5);c.moveTo(game.unit*(f+.5),game.unit*5.5);c.lineTo(game.unit*(f+.5),game.unit*9.5);c.stroke()}}}
  Repeater{model:90
   Button{id:square;required property int index;property int boardIndex:(9-Math.floor(index/9))*9+index%9;property var piece:session.gameBoard[boardIndex]||{};objectName:"xiangqi-"+boardIndex
    x:(index%9)*game.unit;y:Math.floor(index/9)*game.unit;width:game.unit;height:game.unit;enabled:session.gameReady
    Accessible.name:(piece.label||"空位")+" x="+(boardIndex%9)+" y="+Math.floor(boardIndex/9)
    onClicked:session.gameClick(boardIndex)
    background:Rectangle{anchors.centerIn:parent;width:game.unit*.78;height:width;radius:width/2;color:piece.label?"#e1deca":"transparent";border.width:piece.selected?3:piece.label?1:0;border.color:piece.selected?"#158584":"#748778"}
    contentItem:Text{textFormat:Text.PlainText;text:piece.label||"";horizontalAlignment:Text.AlignHCenter;verticalAlignment:Text.AlignVCenter;font.family:"Songti SC";font.pixelSize:game.unit*.48;font.bold:true;color:piece.color==="red"?"#9b4242":"#19393e"}
   }
  }
 }
 RowLayout{Layout.fillWidth:true
  GlassButton{text:"悔一回合";enabled:session.gameReady;onClicked:session.gameUndo()}
  GlassButton{text:"重新开始";onClicked:resetConfirm.open()}
  Item{Layout.fillWidth:true}
 }
 Dialog{id:resetConfirm;title:"重新开始棋局？";modal:true;width:320;standardButtons:Dialog.Ok|Dialog.Cancel;onAccepted:session.gameReset()}
}
