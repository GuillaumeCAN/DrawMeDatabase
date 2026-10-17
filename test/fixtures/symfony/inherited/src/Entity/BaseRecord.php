<?php

namespace App\Entity;

use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\MappedSuperclass]
abstract class BaseRecord
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    protected ?int $id = null;

    // Private fields of a mapped superclass are mapped too
    #[ORM\Column]
    private int $version = 1;

    #[ORM\ManyToMany(targetEntity: Label::class)]
    private Collection $labels;
}
