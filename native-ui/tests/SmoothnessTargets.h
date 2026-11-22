#pragma once
#include <QQuickItem>
#include <QString>
namespace SmoothnessTargets {
inline QQuickItem *find(QQuickItem *root,const QString &name,bool usable=false) {
    if(!root)return nullptr;
    if(root->objectName()==name&&(!usable||(root->isVisible()&&root->isEnabled())))return root;
    for(auto *child:root->childItems())if(auto *item=find(child,name,usable))return item;
    return nullptr;
}
}
