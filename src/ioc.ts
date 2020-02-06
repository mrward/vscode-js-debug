/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container, injectable, inject } from 'inversify';
import 'reflect-metadata';

const IInjector = Symbol('IInjector');

const IFoo = Symbol('IFoo');
const IBar = Symbol('IBar');

let id = 0;

@injectable()
class Bar {
  public id = id++;
}

@injectable()
class Foo {
  constructor(@inject(IBar) public readonly bar: Bar, @inject(IInjector) public readonly container: Container) {
    setTimeout(() => {
      console.log('nested bar', container.get<Bar>(IBar).id);
    }, 1)
  }
}

const container = new Container();
container.bind<any>(IInjector).toDynamicValue(cnt => cnt.container);
container.bind<Bar>(IBar).to(Bar).inRequestScope();
container.bind<Foo>(IFoo).to(Foo);

const a = container.get<Foo>(IFoo);
console.log('outer bar', a.bar.id);

setTimeout(() => {

  const b = container.get<Foo>(IFoo);
  console.log('new bar', b.bar.id);
}, 100)
